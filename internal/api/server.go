package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"kea-dhcp-go/internal/config"
	"kea-dhcp-go/internal/kea"
)

// Server 组装所有 HTTP 接口。
type Server struct {
	kea     *kea.Client
	cfg     *config.Config
	cfgPath string
	ui      fs.FS

	// configMu 保证“读配置-改配置-写回”串行执行，避免并发覆盖。
	configMu sync.Mutex

	cfgMu sync.RWMutex
}

func New(client *kea.Client, cfg *config.Config, cfgPath string, ui fs.FS) *Server {
	return &Server{kea: client, cfg: cfg, cfgPath: cfgPath, ui: ui}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/connection", s.handleGetConnection)
	mux.HandleFunc("POST /api/connection", s.handleSetConnection)
	mux.HandleFunc("POST /api/connection/test", s.handleTestConnection)

	mux.HandleFunc("GET /api/overview", s.handleOverview)

	mux.HandleFunc("GET /api/config", s.handleGetConfig)
	mux.HandleFunc("GET /api/config/download", s.handleDownloadConfig)
	mux.HandleFunc("POST /api/config/test", s.handleTestConfig)
	mux.HandleFunc("POST /api/config/apply", s.handleApplyConfig)

	mux.HandleFunc("GET /api/subnets", s.handleListSubnets)
	mux.HandleFunc("GET /api/subnets/{id}", s.handleGetSubnet)
	mux.HandleFunc("POST /api/subnets", s.handleCreateSubnet)
	mux.HandleFunc("PUT /api/subnets/{id}", s.handleUpdateSubnet)
	mux.HandleFunc("DELETE /api/subnets/{id}", s.handleDeleteSubnet)

	mux.HandleFunc("POST /api/subnets/{id}/pools", s.handleAddPool)
	mux.HandleFunc("DELETE /api/subnets/{id}/pools", s.handleDeletePool)

	mux.HandleFunc("POST /api/subnets/{id}/reservations", s.handleAddReservation)
	mux.HandleFunc("DELETE /api/subnets/{id}/reservations", s.handleDeleteReservation)

	mux.HandleFunc("GET /api/leases/capability", s.handleLeaseCapability)
	mux.HandleFunc("POST /api/leases/query", s.handleLeaseQuery)
	mux.HandleFunc("POST /api/leases/bind", s.handleBindReservations)
	mux.HandleFunc("POST /api/leases/modify", s.handleLeaseModify)
	mux.HandleFunc("DELETE /api/leases", s.handleLeaseDelete)
	mux.HandleFunc("POST /api/leases/wipe", s.handleLeaseWipe)

	mux.HandleFunc("GET /api/stats", s.handleStats)
	mux.HandleFunc("POST /api/stats/reset", s.handleStatsReset)

	mux.HandleFunc("GET /api/commands", s.handleCommands)
	mux.HandleFunc("POST /api/command", s.handleCommand)

	mux.HandleFunc("POST /api/server/action", s.handleServerAction)

	if s.ui != nil {
		mux.Handle("GET /", http.FileServerFS(s.ui))
	}

	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if v := recover(); v != nil {
				log.Printf("panic: %v", v)
				if !rec.wrote {
					writeError(rec, http.StatusInternalServerError, "服务内部错误")
				}
			}
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				return
			}
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}()
		next.ServeHTTP(rec, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.wrote = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.ResponseWriter.Write(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeKeaError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	if kea.IsUnsupported(err) {
		status = http.StatusNotImplemented
	}
	var ke *kea.Error
	if errors.As(err, &ke) && ke.Result == kea.ResultError {
		status = http.StatusBadRequest
	}
	writeError(w, status, err.Error())
}

// decodeJSON 严格解码请求体，保留数字精度。
func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("请求体为空")
		}
		return err
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	keaURL, _ := s.kea.Connection()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "kea-dhcp-go",
		"kea_url": keaURL,
		"time":    time.Now().Format(time.RFC3339),
	})
}

func (s *Server) handleGetConnection(w http.ResponseWriter, r *http.Request) {
	keaURL, user := s.kea.Connection()
	s.cfgMu.RLock()
	cfgPath := s.cfgPath
	s.cfgMu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"url":          keaURL,
		"user":         user,
		"password_set": true,
		"cfg_path":     cfgPath,
	})
}

type connectionReq struct {
	URL      string `json:"url"`
	User     string `json:"user"`
	Password string `json:"password"`
}

func (s *Server) handleSetConnection(w http.ResponseWriter, r *http.Request) {
	var req connectionReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if err := s.kea.SetConnection(req.URL, req.User, req.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	keaURL, user := s.kea.Connection()

	s.cfgMu.Lock()
	saved := false
	var saveErr error
	if s.cfgPath != "" {
		s.cfg.KeaURL = keaURL
		s.cfg.KeaUser = user
		if req.Password != "" {
			s.cfg.KeaPass = req.Password
		}
		saveErr = s.cfg.Save(s.cfgPath)
		saved = saveErr == nil
	}
	s.cfgMu.Unlock()

	resp := map[string]any{"url": keaURL, "user": user, "saved": saved}
	if saveErr != nil {
		resp["warning"] = "连接已生效，但写入配置文件失败：" + saveErr.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleTestConnection(w http.ResponseWriter, r *http.Request) {
	var req connectionReq
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
			return
		}
	}
	if req.URL != "" || req.User != "" || req.Password != "" {
		s.testWith(w, r.Context(), s.kea.CloneWith(req.URL, req.User, req.Password))
		return
	}
	s.testWith(w, r.Context(), s.kea)
}

func (s *Server) testWith(w http.ResponseWriter, ctx context.Context, client *kea.Client) {
	start := time.Now()
	raw, err := client.Call(ctx, "version-get", []string{"dhcp4"}, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var v struct {
		Extended string `json:"extended"`
	}
	_ = json.Unmarshal(raw, &v)
	keaURL, _ := client.Connection()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"url":        keaURL,
		"version":    firstLine(v.Extended),
		"extended":   v.Extended,
		"latency_ms": time.Since(start).Milliseconds(),
	})
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
