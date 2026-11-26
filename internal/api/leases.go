package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"

	"kea-dhcp-go/internal/kea"
)

// Kea 命令返回码：3 表示"未找到"，不是错误。
const resultEmpty = 3

var leaseHints = map[string]string{
	"lease4-get-all":           "需要 Kea 加载 lease_cmds 钩子库（libdhcp_lease_cmds.so）",
	"lease4-get":               "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-get-by-hostname":   "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-get-by-hw-address": "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-get-by-client-id":  "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-update":            "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-add":               "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-del":               "需要 Kea 加载 lease_cmds 钩子库",
	"lease4-wipe":              "需要 Kea 加载 lease_cmds 钩子库",
}

var macPattern = regexp.MustCompile(`^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$`)

func errorMessage(resp *kea.Response) string {
	if resp.Text != "" {
		return resp.Text
	}
	return fmt.Sprintf("Kea 返回 result=%d", resp.Result)
}

func (s *Server) handleLeaseCapability(w http.ResponseWriter, r *http.Request) {
	raw, err := s.kea.Call(r.Context(), "list-commands", serviceList, nil)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	var cmds []string
	_ = json.Unmarshal(raw, &cmds)
	leaseCmds := make([]string, 0)
	for _, c := range cmds {
		if strings.HasPrefix(c, "lease4-") || strings.HasPrefix(c, "lease6-") {
			leaseCmds = append(leaseCmds, c)
		}
	}
	resp := map[string]any{
		"commands":   leaseCmds,
		"lease_cmds": len(leaseCmds) > 0,
		"update":     contains(cmds, "lease4-update"),
	}
	if len(leaseCmds) == 0 {
		resp["hint"] = "当前 Kea 未启用租约命令钩子，租约查询与修改不可用。"
	}
	writeJSON(w, http.StatusOK, resp)
}

func contains(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}

// normalizeLeases 把 Kea 各命令返回的租约数据形态统一为数组。
func normalizeLeases(raw json.RawMessage) []any {
	if len(raw) == 0 {
		return []any{}
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return []any{}
	}
	switch t := v.(type) {
	case []any:
		return t
	case map[string]any:
		if arr, ok := t["leases"].([]any); ok {
			return arr
		}
		if arr, ok := t["leases4"].([]any); ok {
			return arr
		}
		if l, ok := t["lease4"].(map[string]any); ok {
			return []any{l}
		}
		if _, ok := t["ip-address"]; ok {
			return []any{t}
		}
	}
	return []any{}
}

type leaseQueryReq struct {
	Type     string `json:"type"`
	SubnetID int64  `json:"subnet_id"`
	Value    string `json:"value"`
}

// handleLeaseQuery 查询租约：all（可选子网过滤）或按 IP/主机名/MAC/ClientID 精确查询。
func (s *Server) handleLeaseQuery(w http.ResponseWriter, r *http.Request) {
	var req leaseQueryReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))
	value := strings.TrimSpace(req.Value)

	var command string
	args := map[string]any{}
	hasArgs := false
	switch req.Type {
	case "", "all":
		command = "lease4-get-all"
		if req.SubnetID > 0 {
			args["subnet-id"] = req.SubnetID
			hasArgs = true
		}
	case "ip":
		command = "lease4-get"
		args["ip-address"] = value
		hasArgs = true
	case "hostname":
		command = "lease4-get-by-hostname"
		args["hostname"] = value
		hasArgs = true
	case "hw":
		command = "lease4-get-by-hw-address"
		args["hw-address"] = strings.ToLower(value)
		hasArgs = true
	case "clientid":
		command = "lease4-get-by-client-id"
		args["client-id"] = value
		hasArgs = true
	default:
		writeError(w, http.StatusBadRequest, "不支持的查询类型："+req.Type)
		return
	}
	if command != "lease4-get-all" && value == "" {
		writeError(w, http.StatusBadRequest, "查询内容不能为空")
		return
	}

	var callArgs any
	if hasArgs {
		callArgs = args
	}
	resp, err := s.kea.Exec(r.Context(), command, serviceList, callArgs)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	if resp.Result != kea.ResultSuccess {
		// result=3 表示未找到匹配租约，返回空列表而不是报错。
		if resp.Result == resultEmpty {
			writeJSON(w, http.StatusOK, map[string]any{"leases": []any{}, "result": resp.Result, "text": "没有匹配的租约"})
			return
		}
		hint := leaseHints[command]
		status := http.StatusBadGateway
		switch {
		case resp.Result == kea.ResultUnsupported:
			status = http.StatusNotImplemented
		case strings.Contains(strings.ToLower(resp.Text), "not supported"),
			strings.Contains(strings.ToLower(resp.Text), "unknown command"),
			strings.Contains(strings.ToLower(resp.Text), "not loaded"):
			status = http.StatusNotImplemented
		default:
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"error": errorMessage(resp), "result": resp.Result, "hint": hint})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"leases": normalizeLeases(resp.Arguments),
		"result": resp.Result,
		"text":   resp.Text,
	})
}

// handleLeaseDelete 删除单个租约，lease4-del 只需要 IP 地址。
func (s *Server) handleLeaseDelete(w http.ResponseWriter, r *http.Request) {
	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	if ip == "" {
		writeError(w, http.StatusBadRequest, "需要 ip 参数")
		return
	}
	resp, err := s.kea.Exec(r.Context(), "lease4-del", serviceList, map[string]any{"ip-address": ip})
	if err != nil {
		writeKeaError(w, err)
		return
	}
	if resp.Result != kea.ResultSuccess {
		status := http.StatusBadRequest
		if resp.Result == kea.ResultUnsupported {
			status = http.StatusNotImplemented
		}
		writeJSON(w, status, map[string]any{"error": errorMessage(resp), "result": resp.Result, "hint": leaseHints["lease4-del"]})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": resp.Text})
}

func (s *Server) handleLeaseWipe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SubnetID int64 `json:"subnet_id"`
	}
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if req.SubnetID <= 0 {
		writeError(w, http.StatusBadRequest, "需要 subnet_id")
		return
	}
	s.execSimpleLease(w, r, "lease4-wipe", map[string]any{"subnet-id": req.SubnetID})
}

// execSimpleLease 执行租约命令并统一返回。
func (s *Server) execSimpleLease(w http.ResponseWriter, r *http.Request, command string, args map[string]any) {
	resp, err := s.kea.Exec(r.Context(), command, serviceList, args)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	if resp.Result != kea.ResultSuccess {
		status := http.StatusBadRequest
		if resp.Result == kea.ResultUnsupported {
			status = http.StatusNotImplemented
		}
		writeJSON(w, status, map[string]any{"error": errorMessage(resp), "result": resp.Result, "hint": leaseHints[command]})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": resp.Text})
}

type leaseModifyReq struct {
	Mode      string `json:"mode"` // mac | ip
	IPAddress string `json:"ip_address"`
	NewMAC    string `json:"new_mac"`
	NewIP     string `json:"new_ip"`
	HWAddress string `json:"hw_address"`
	ClientID  string `json:"client_id"`
	Hostname  string `json:"hostname"`
	SubnetID  int64  `json:"subnet_id"`
	ValidLft  int64  `json:"valid_lft"`
	Expire    int64  `json:"expire"`
	State     int    `json:"state"`
	FqdnFwd   *bool  `json:"fqdn_fwd"`
	FqdnRev   *bool  `json:"fqdn_rev"`
}

// buildLeaseArgs 以完整字段构建租约参数，未提供的可选字段跳过，
// 避免 lease4-update / lease4-add 将未知字段重置为默认值。
func (q *leaseModifyReq) buildLeaseArgs(ip, mac string) map[string]any {
	args := map[string]any{
		"ip-address": ip,
		"hw-address": strings.ToLower(mac),
		"subnet-id":  q.SubnetID,
	}
	if q.ClientID != "" {
		args["client-id"] = q.ClientID
	}
	if q.Hostname != "" {
		args["hostname"] = q.Hostname
	}
	if q.ValidLft > 0 {
		args["valid-lft"] = q.ValidLft
	}
	if q.Expire > 0 {
		args["expire"] = q.Expire
	}
	if q.State > 0 {
		args["state"] = q.State
	}
	if q.FqdnFwd != nil {
		args["fqdn-fwd"] = *q.FqdnFwd
	}
	if q.FqdnRev != nil {
		args["fqdn-rev"] = *q.FqdnRev
	}
	return args
}

// handleLeaseModify 修改租约：
//   - mode=mac：同 IP 更新 MAC 地址（lease4-update），立即生效；
//   - mode=ip ：迁移到新 IP（lease4-add 新租约 + lease4-del 旧租约）。
//
// 修改后客户端重新申请即获得新租约信息。
func (s *Server) handleLeaseModify(w http.ResponseWriter, r *http.Request) {
	var req leaseModifyReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	req.Mode = strings.ToLower(strings.TrimSpace(req.Mode))
	req.IPAddress = strings.TrimSpace(req.IPAddress)
	req.NewMAC = strings.ToLower(strings.TrimSpace(req.NewMAC))
	req.NewIP = strings.TrimSpace(req.NewIP)
	req.HWAddress = strings.TrimSpace(req.HWAddress)

	if req.SubnetID <= 0 {
		writeError(w, http.StatusBadRequest, "缺少 subnet_id（子网 ID）")
		return
	}
	if req.IPAddress == "" {
		writeError(w, http.StatusBadRequest, "缺少 ip_address（当前租约 IP）")
		return
	}

	switch req.Mode {
	case "mac":
		if req.NewMAC == "" {
			writeError(w, http.StatusBadRequest, "请填写新的 MAC 地址")
			return
		}
		if !macPattern.MatchString(req.NewMAC) {
			writeError(w, http.StatusBadRequest, "MAC 地址格式不合法，应为 aa:bb:cc:dd:ee:ff")
			return
		}
		args := req.buildLeaseArgs(req.IPAddress, req.NewMAC)
		s.execSimpleLease(w, r, "lease4-update", args)

	case "ip":
		if req.NewIP == "" {
			writeError(w, http.StatusBadRequest, "请填写新的 IP 地址")
			return
		}
		if net.ParseIP(req.NewIP) == nil || net.ParseIP(req.NewIP).To4() == nil {
			writeError(w, http.StatusBadRequest, "新 IP 地址格式不合法："+req.NewIP)
			return
		}
		if req.NewIP == req.IPAddress {
			writeError(w, http.StatusBadRequest, "新 IP 与当前 IP 相同")
			return
		}
		if req.HWAddress == "" {
			writeError(w, http.StatusBadRequest, "缺少 hw_address（要保留的 MAC 地址）")
			return
		}
		// 先在新 IP 创建租约（保留 MAC、主机名等），失败则不影响原租约。
		addArgs := req.buildLeaseArgs(req.NewIP, req.HWAddress)
		resp, err := s.kea.Exec(r.Context(), "lease4-add", serviceList, addArgs)
		if err != nil {
			writeKeaError(w, err)
			return
		}
		if resp.Result != kea.ResultSuccess {
			status := http.StatusBadRequest
			if resp.Result == kea.ResultUnsupported {
				status = http.StatusNotImplemented
			}
			writeJSON(w, status, map[string]any{
				"error": "新租约创建失败：" + errorMessage(resp),
				"hint":  leaseHints["lease4-add"],
			})
			return
		}
		// 再删除旧 IP 的租约，完成迁移。
		delResp, err := s.kea.Exec(r.Context(), "lease4-del", serviceList, map[string]any{"ip-address": req.IPAddress})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":      true,
				"warning": "新 IP 租约已创建，但删除旧租约时出错：" + err.Error(),
			})
			return
		}
		if delResp.Result != kea.ResultSuccess {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":      true,
				"warning": "新 IP 租约已创建，但旧租约删除失败：" + errorMessage(delResp) + "（请手动删除旧租约）",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": fmt.Sprintf("租约已从 %s 迁移到 %s", req.IPAddress, req.NewIP),
		})

	default:
		writeError(w, http.StatusBadRequest, "mode 仅支持 mac / ip")
	}
}
