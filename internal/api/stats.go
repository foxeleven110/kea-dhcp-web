package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"kea-dhcp-go/internal/kea"
)

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	var (
		raw json.RawMessage
		err error
	)
	if name != "" {
		raw, err = s.kea.Call(r.Context(), "statistic-get", serviceList, map[string]any{"name": name})
	} else {
		raw, err = s.kea.Call(r.Context(), "statistic-get-all", serviceList, nil)
	}
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": raw})
}

type statsResetReq struct {
	Mode string `json:"mode"`
	Name string `json:"name"`
}

func (s *Server) handleStatsReset(w http.ResponseWriter, r *http.Request) {
	var req statsResetReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	var cmd string
	var args any
	switch req.Mode {
	case "reset":
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "reset 模式需要 name")
			return
		}
		cmd, args = "statistic-reset", map[string]any{"name": req.Name}
	case "reset-all":
		cmd = "statistic-reset-all"
	case "remove-all":
		cmd = "statistic-remove-all"
	default:
		writeError(w, http.StatusBadRequest, "mode 仅支持 reset / reset-all / remove-all")
		return
	}
	resp, err := s.kea.Exec(r.Context(), cmd, serviceList, args)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	if resp.Result != kea.ResultSuccess {
		writeError(w, http.StatusBadRequest, resp.Text)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": resp.Text})
}

func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	raw, err := s.kea.Call(r.Context(), "list-commands", serviceList, nil)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": raw})
}

type commandReq struct {
	Command   string   `json:"command"`
	Service   []string `json:"service"`
	Arguments any      `json:"arguments"`
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	var req commandReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	req.Command = strings.TrimSpace(req.Command)
	if req.Command == "" {
		writeError(w, http.StatusBadRequest, "command 不能为空")
		return
	}
	service := req.Service
	if len(service) == 0 {
		service = serviceList
	}
	resp, err := s.kea.Exec(r.Context(), req.Command, service, req.Arguments)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"command":   req.Command,
		"result":    resp.Result,
		"text":      resp.Text,
		"arguments": resp.Arguments,
	})
}

type serverActionReq struct {
	Action string `json:"action"`
}

func (s *Server) handleServerAction(w http.ResponseWriter, r *http.Request) {
	var req serverActionReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	var cmd string
	var args any
	switch req.Action {
	case "enable":
		cmd, args = "dhcp-enable", map[string]any{"origin": "user"}
	case "disable":
		cmd, args = "dhcp-disable", map[string]any{"origin": "user", "type": "all"}
	case "reload":
		cmd = "config-reload"
	case "shutdown":
		cmd = "shutdown"
	default:
		writeError(w, http.StatusBadRequest, "action 仅支持 enable / disable / reload / shutdown")
		return
	}
	resp, err := s.kea.Exec(r.Context(), cmd, serviceList, args)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	if resp.Result != kea.ResultSuccess {
		writeError(w, http.StatusBadRequest, resp.Text)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": resp.Text})
}
