package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

const dhcp4Service = "dhcp4"

var serviceList = []string{dhcp4Service}

// decodeMap 解码为 map 并保留数字原始形式。
func decodeMap(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	return dec.Decode(dst)
}

func marshalNumber(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func numberInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case float64:
		return int64(n), true
	case int:
		return int64(n), true
	case int64:
		return n, true
	}
	return 0, false
}

// getDhcp4 读取当前运行配置中的 Dhcp4 对象与配置指纹。
func (s *Server) getDhcp4(ctx context.Context) (map[string]any, string, error) {
	raw, err := s.kea.Call(ctx, "config-get", serviceList, nil)
	if err != nil {
		return nil, "", err
	}
	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return nil, "", fmt.Errorf("解析 config-get 响应失败：%w", err)
	}
	cfg, ok := root["Dhcp4"].(map[string]any)
	if !ok {
		return nil, "", errors.New("config-get 响应中缺少 Dhcp4 配置")
	}
	hash, _ := root["hash"].(string)
	return cfg, hash, nil
}

// withDhcp4 串行完成：读取 → 修改 → 校验 → 应用 →（可选）落盘/重载。
func (s *Server) withDhcp4(ctx context.Context, mutate func(cfg map[string]any) error, write, reload bool) (map[string]any, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()

	cfg, _, err := s.getDhcp4(ctx)
	if err != nil {
		return nil, err
	}
	if err := mutate(cfg); err != nil {
		return nil, err
	}
	payload := map[string]any{"Dhcp4": cfg}

	if _, err := s.kea.Call(ctx, "config-test", serviceList, payload); err != nil {
		return nil, fmt.Errorf("配置校验未通过：%w", err)
	}
	if _, err := s.kea.Call(ctx, "config-set", serviceList, payload); err != nil {
		return nil, fmt.Errorf("配置应用失败：%w", err)
	}
	if write {
		if _, err := s.kea.Call(ctx, "config-write", serviceList, nil); err != nil {
			return nil, fmt.Errorf("配置已生效但写入文件失败：%w", err)
		}
	}
	if reload {
		if _, err := s.kea.Call(ctx, "config-reload", serviceList, nil); err != nil {
			return nil, fmt.Errorf("配置已写入但重载失败：%w", err)
		}
	}
	return cfg, nil
}

func subnetList(cfg map[string]any) []any {
	if arr, ok := cfg["subnet4"].([]any); ok {
		return arr
	}
	return []any{}
}

func setSubnetList(cfg map[string]any, arr []any) {
	cfg["subnet4"] = arr
}

func findSubnetIndex(arr []any, id int64) int {
	for i, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if v, ok := numberInt(m["id"]); ok && v == id {
			return i
		}
	}
	return -1
}

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func asSlice(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return []any{}
}

func stringList(v any) []string {
	arr := asSlice(v)
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	type result struct {
		version any
		status  any
		subnets int
		hash    string
		err     error
	}
	ch := make(chan result, 1)
	go func() {
		var out result
		if raw, err := s.kea.Call(ctx, "version-get", serviceList, nil); err == nil {
			var v map[string]any
			_ = json.Unmarshal(raw, &v)
			out.version = v
		} else {
			out.err = err
		}
		if raw, err := s.kea.Call(ctx, "status-get", serviceList, nil); err == nil {
			var st map[string]any
			_ = json.Unmarshal(raw, &st)
			out.status = st
		} else if out.err == nil {
			out.err = err
		}
		if cfg, hash, err := s.getDhcp4(ctx); err == nil {
			out.subnets = len(subnetList(cfg))
			out.hash = hash
		}
		ch <- out
	}()
	out := <-ch
	if out.err != nil {
		writeKeaError(w, out.err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": out.version,
		"status":  out.status,
		"subnets": out.subnets,
		"hash":    out.hash,
	})
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	service := r.URL.Query().Get("service")
	if service == "" {
		service = dhcp4Service
	}
	raw, err := s.kea.Call(r.Context(), "config-get", []string{service}, nil)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		writeError(w, http.StatusBadGateway, "解析配置失败："+err.Error())
		return
	}
	key := "Dhcp4"
	if service == "dhcp-ddns" || service == "d2" {
		key = "DhcpDdns"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service": service,
		"config":  root[key],
		"hash":    root["hash"],
		"raw":     root,
	})
}

func (s *Server) handleDownloadConfig(w http.ResponseWriter, r *http.Request) {
	raw, err := s.kea.Call(r.Context(), "config-get", serviceList, nil)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		writeError(w, http.StatusBadGateway, "解析配置失败："+err.Error())
		return
	}
	delete(root, "hash")
	data, err := json.MarshalIndent(map[string]any{"Dhcp4": root["Dhcp4"]}, "", "    ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="kea-dhcp4.json"`)
	w.WriteHeader(http.StatusOK)
	w.Write(append(data, '\n'))
}

type configPayload struct {
	Config map[string]any `json:"config"`
	Write  *bool          `json:"write"`
	Reload *bool          `json:"reload"`
}

func (s *Server) handleTestConfig(w http.ResponseWriter, r *http.Request) {
	var req configPayload
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if req.Config == nil {
		writeError(w, http.StatusBadRequest, "缺少 config 字段")
		return
	}
	if _, err := s.kea.Call(r.Context(), "config-test", serviceList, map[string]any{"Dhcp4": req.Config}); err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "配置校验通过"})
}

func (s *Server) handleApplyConfig(w http.ResponseWriter, r *http.Request) {
	var req configPayload
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if req.Config == nil {
		writeError(w, http.StatusBadRequest, "缺少 config 字段")
		return
	}
	write := true
	if req.Write != nil {
		write = *req.Write
	}
	reload := false
	if req.Reload != nil {
		reload = *req.Reload
	}

	s.configMu.Lock()
	defer s.configMu.Unlock()

	payload := map[string]any{"Dhcp4": req.Config}
	if _, err := s.kea.Call(r.Context(), "config-test", serviceList, payload); err != nil {
		writeError(w, http.StatusBadRequest, "配置校验未通过："+err.Error())
		return
	}
	if _, err := s.kea.Call(r.Context(), "config-set", serviceList, payload); err != nil {
		writeKeaError(w, err)
		return
	}
	result := map[string]any{"ok": true, "applied": true, "written": false, "reloaded": false}
	if write {
		if _, err := s.kea.Call(r.Context(), "config-write", serviceList, nil); err != nil {
			result["warning"] = "配置已生效，但写入文件失败：" + err.Error()
			writeJSON(w, http.StatusOK, result)
			return
		}
		result["written"] = true
	}
	if reload {
		if _, err := s.kea.Call(r.Context(), "config-reload", serviceList, nil); err != nil {
			result["warning"] = "配置已生效，但重载失败：" + err.Error()
			writeJSON(w, http.StatusOK, result)
			return
		}
		result["reloaded"] = true
	}
	writeJSON(w, http.StatusOK, result)
}
