package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type subnetView struct {
	ID            int64          `json:"id"`
	Subnet        string         `json:"subnet"`
	Interface     string         `json:"interface"`
	Pools         []string       `json:"pools"`
	Reservations  int            `json:"reservations"`
	ValidLifetime any            `json:"valid_lifetime"`
	Raw           map[string]any `json:"raw"`
}

func toSubnetView(m map[string]any) subnetView {
	v := subnetView{Raw: m}
	if id, ok := numberInt(m["id"]); ok {
		v.ID = id
	}
	v.Subnet, _ = m["subnet"].(string)
	v.Interface, _ = m["interface"].(string)
	v.ValidLifetime = m["valid-lifetime"]
	for _, p := range asSlice(m["pools"]) {
		if pm, ok := asMap(p); ok {
			if s, ok := pm["pool"].(string); ok {
				v.Pools = append(v.Pools, s)
			}
		}
	}
	if v.Pools == nil {
		v.Pools = []string{}
	}
	v.Reservations = len(asSlice(m["reservations"]))
	return v
}

func (s *Server) handleListSubnets(w http.ResponseWriter, r *http.Request) {
	cfg, hash, err := s.getDhcp4(r.Context())
	if err != nil {
		writeKeaError(w, err)
		return
	}
	views := make([]subnetView, 0)
	for _, item := range subnetList(cfg) {
		if m, ok := asMap(item); ok {
			views = append(views, toSubnetView(m))
		}
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	writeJSON(w, http.StatusOK, map[string]any{"subnets": views, "hash": hash})
}

func (s *Server) handleGetSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cfg, _, err := s.getDhcp4(r.Context())
	if err != nil {
		writeKeaError(w, err)
		return
	}
	arr := subnetList(cfg)
	idx := findSubnetIndex(arr, id)
	if idx < 0 {
		writeError(w, http.StatusNotFound, fmt.Sprintf("子网 %d 不存在", id))
		return
	}
	m, _ := asMap(arr[idx])
	writeJSON(w, http.StatusOK, map[string]any{"subnet": toSubnetView(m)})
}

func pathID(r *http.Request) (int64, error) {
	raw := r.PathValue("id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("子网 ID 不合法：%s", raw)
	}
	return id, nil
}

type subnetPayload struct {
	Raw    map[string]any `json:"raw"`
	Write  *bool          `json:"write"`
	Reload *bool          `json:"reload"`
}

func (s *Server) handleCreateSubnet(w http.ResponseWriter, r *http.Request) {
	var req subnetPayload
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if err := validateSubnet(req.Raw); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	id, _ := numberInt(req.Raw["id"])
	var created map[string]any
	_, err := s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		if findSubnetIndex(arr, id) >= 0 {
			return fmt.Errorf("子网 ID %d 已存在", id)
		}
		arr = append(arr, req.Raw)
		setSubnetList(cfg, arr)
		created = req.Raw
		return nil
	}, boolOrDefault(req.Write, true), boolOrDefault(req.Reload, false))
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(created)})
}

func (s *Server) handleUpdateSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req subnetPayload
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if req.Raw == nil {
		writeError(w, http.StatusBadRequest, "缺少 raw 字段")
		return
	}
	req.Raw["id"] = jsonNumber(id)
	if err := validateSubnet(req.Raw); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var updated map[string]any
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		arr[idx] = req.Raw
		setSubnetList(cfg, arr)
		updated = req.Raw
		return nil
	}, boolOrDefault(req.Write, true), boolOrDefault(req.Reload, false))
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(updated)})
}

func (s *Server) handleDeleteSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOpt := queryBool(r, "write", true)
	reloadOpt := queryBool(r, "reload", false)
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		arr = append(arr[:idx], arr[idx+1:]...)
		setSubnetList(cfg, arr)
		return nil
	}, writeOpt, reloadOpt)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func validateSubnet(m map[string]any) error {
	if m == nil {
		return errors.New("缺少子网内容")
	}
	id, ok := numberInt(m["id"])
	if !ok || id <= 0 {
		return errors.New("子网 id 必须为正整数")
	}
	subnet, _ := m["subnet"].(string)
	if strings.TrimSpace(subnet) == "" {
		return errors.New("subnet 网段不能为空，例如 192.168.10.0/24")
	}
	if _, _, err := parseCIDR(subnet); err != nil {
		return fmt.Errorf("subnet 格式不合法：%v", err)
	}
	for _, p := range asSlice(m["pools"]) {
		pm, ok := asMap(p)
		if !ok {
			return errors.New("pools 元素必须是对象")
		}
		if v, _ := pm["pool"].(string); strings.TrimSpace(v) == "" {
			return errors.New("pools 中 pool 不能为空")
		}
	}
	return nil
}

func jsonNumber(v int64) interface{} {
	return json.Number(strconv.FormatInt(v, 10))
}

func boolOrDefault(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func queryBool(r *http.Request, key string, def bool) bool {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// ---------- 地址池 ----------

type poolPayload struct {
	Pool  string   `json:"pool"`
	Pools []string `json:"pools"`
}

func (s *Server) handleAddPool(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req poolPayload
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	items := req.Pools
	if req.Pool != "" {
		items = append(items, req.Pool)
	}
	if len(items) == 0 {
		writeError(w, http.StatusBadRequest, "请提供 pool 地址池范围")
		return
	}
	var updated map[string]any
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		m, _ := asMap(arr[idx])
		pools := asSlice(m["pools"])
		existing := map[string]bool{}
		for _, p := range pools {
			if pm, ok := asMap(p); ok {
				if v, ok := pm["pool"].(string); ok {
					existing[v] = true
				}
			}
		}
		for _, item := range items {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			if existing[item] {
				return fmt.Errorf("地址池 %s 已存在", item)
			}
			if err := validatePool(item); err != nil {
				return err
			}
			pools = append(pools, map[string]any{"pool": item, "option-data": []any{}})
		}
		m["pools"] = pools
		arr[idx] = m
		setSubnetList(cfg, arr)
		updated = m
		return nil
	}, true, false)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(updated)})
}

func (s *Server) handleDeletePool(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pool := strings.TrimSpace(r.URL.Query().Get("pool"))
	if pool == "" {
		writeError(w, http.StatusBadRequest, "缺少 pool 查询参数")
		return
	}
	var updated map[string]any
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		m, _ := asMap(arr[idx])
		src := asSlice(m["pools"])
		out := make([]any, 0, len(src))
		found := false
		for _, p := range src {
			if pm, ok := asMap(p); ok {
				if v, _ := pm["pool"].(string); v == pool {
					found = true
					continue
				}
			}
			out = append(out, p)
		}
		if !found {
			return fmt.Errorf("地址池 %s 不存在", pool)
		}
		m["pools"] = out
		arr[idx] = m
		setSubnetList(cfg, arr)
		updated = m
		return nil
	}, true, false)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(updated)})
}

// ---------- 保留地址 ----------

func (s *Server) handleAddReservation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body map[string]any
	if err := decodeMap(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	item := body
	if inner, ok := asMap(body["reservation"]); ok {
		item = inner
	}
	if err := validateReservation(item); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var updated map[string]any
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		m, _ := asMap(arr[idx])
		list := asSlice(m["reservations"])
		if ip, _ := item["ip-address"].(string); ip != "" {
			for _, rv := range list {
				if rm, ok := asMap(rv); ok {
					if v, _ := rm["ip-address"].(string); v == ip {
						return fmt.Errorf("IP %s 已存在保留地址", ip)
					}
				}
			}
		}
		list = append(list, item)
		m["reservations"] = list
		arr[idx] = m
		setSubnetList(cfg, arr)
		updated = m
		return nil
	}, true, false)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(updated)})
}

func (s *Server) handleDeleteReservation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	indexRaw := r.URL.Query().Get("index")
	index := -1
	if indexRaw != "" {
		v, err := strconv.Atoi(indexRaw)
		if err != nil || v < 0 {
			writeError(w, http.StatusBadRequest, "index 参数不合法")
			return
		}
		index = v
	}
	if ip == "" && index < 0 {
		writeError(w, http.StatusBadRequest, "需要提供 ip 或 index 参数")
		return
	}
	var updated map[string]any
	_, err = s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		idx := findSubnetIndex(arr, id)
		if idx < 0 {
			return fmt.Errorf("子网 %d 不存在", id)
		}
		m, _ := asMap(arr[idx])
		src := asSlice(m["reservations"])
		out := make([]any, 0, len(src))
		found := false
		for i, rv := range src {
			if index >= 0 && i == index {
				found = true
				continue
			}
			if ip != "" {
				if rm, ok := asMap(rv); ok {
					if v, _ := rm["ip-address"].(string); v == ip {
						found = true
						continue
					}
				}
			}
			out = append(out, rv)
		}
		if !found {
			return errors.New("未找到要删除的保留地址")
		}
		m["reservations"] = out
		arr[idx] = m
		setSubnetList(cfg, arr)
		updated = m
		return nil
	}, true, false)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subnet": toSubnetView(updated)})
}

// ---------- 静态绑定（租约地址写入子网保留地址） ----------

type bindReservationItem struct {
	IPAddress string `json:"ip_address"`
	HWAddress string `json:"hw_address"`
	Hostname  string `json:"hostname"`
	SubnetID  int64  `json:"subnet_id"`
}

type bindReservationReq struct {
	Reservations []bindReservationItem `json:"reservations"`
}

// handleBindReservations 把一组租约地址批量写入对应子网的 reservations，
// 一次 config-test → config-set → config-write 完成；重复地址自动跳过。
func (s *Server) handleBindReservations(w http.ResponseWriter, r *http.Request) {
	var req bindReservationReq
	if err := decodeMap(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "参数错误："+err.Error())
		return
	}
	if len(req.Reservations) == 0 {
		writeError(w, http.StatusBadRequest, "没有可绑定的地址")
		return
	}
	for _, it := range req.Reservations {
		if strings.TrimSpace(it.IPAddress) == "" {
			writeError(w, http.StatusBadRequest, "存在未填写 IP 地址的绑定项")
			return
		}
		if strings.TrimSpace(it.HWAddress) == "" {
			writeError(w, http.StatusBadRequest, "存在未填写 MAC 地址的绑定项："+it.IPAddress)
			return
		}
	}

	added, skipped := 0, 0
	problems := make([]string, 0)
	_, err := s.withDhcp4(r.Context(), func(cfg map[string]any) error {
		arr := subnetList(cfg)
		for _, it := range req.Reservations {
			idx := findSubnetIndex(arr, it.SubnetID)
			if idx < 0 {
				problems = append(problems, fmt.Sprintf("IP %s：子网 %d 不存在", it.IPAddress, it.SubnetID))
				continue
			}
			ip, _, err := parseIP(it.IPAddress)
			if err != nil || ip.To4() == nil {
				problems = append(problems, "IP "+it.IPAddress+" 不是合法 IPv4 地址")
				continue
			}
			m, _ := asMap(arr[idx])
			if subnetStr, _ := m["subnet"].(string); subnetStr != "" {
				if _, ipnet, err := parseCIDR(subnetStr); err != nil || !ipnet.Contains(ip) {
					problems = append(problems, fmt.Sprintf("IP %s 不在子网 %s 内", it.IPAddress, subnetStr))
					continue
				}
			}
			list := asSlice(m["reservations"])
			dup := false
			for _, rv := range list {
				if rm, ok := asMap(rv); ok {
					if v, _ := rm["ip-address"].(string); v == it.IPAddress {
						dup = true
						break
					}
				}
			}
			if dup {
				skipped++
				continue
			}
			res := map[string]any{"ip-address": it.IPAddress, "hw-address": strings.ToLower(it.HWAddress)}
			if strings.TrimSpace(it.Hostname) != "" {
				res["hostname"] = strings.TrimSpace(it.Hostname)
			}
			list = append(list, res)
			m["reservations"] = list
			arr[idx] = m
			added++
		}
		setSubnetList(cfg, arr)
		return nil
	}, true, false)
	if err != nil {
		writeKeaError(w, err)
		return
	}
	resp := map[string]any{"ok": true, "added": added, "skipped": skipped}
	if len(problems) > 0 {
		resp["warning"] = strings.Join(problems, "；")
	}
	writeJSON(w, http.StatusOK, resp)
}

func validateReservation(m map[string]any) error {
	if m == nil {
		return errors.New("保留地址内容不能为空")
	}
	ip, _ := m["ip-address"].(string)
	hw, _ := m["hw-address"].(string)
	cid, _ := m["client-id"].(string)
	if strings.TrimSpace(ip) == "" {
		return errors.New("ip-address 不能为空")
	}
	if strings.TrimSpace(hw) == "" && strings.TrimSpace(cid) == "" {
		return errors.New("hw-address 与 client-id 至少填写一项")
	}
	if _, _, err := parseIP(ip); err != nil {
		return fmt.Errorf("ip-address 不合法：%v", err)
	}
	return nil
}
