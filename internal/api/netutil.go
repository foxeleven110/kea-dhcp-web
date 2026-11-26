package api

import (
	"fmt"
	"net"
	"strings"
)

func parseCIDR(s string) (net.IP, *net.IPNet, error) {
	ip, ipnet, err := net.ParseCIDR(strings.TrimSpace(s))
	if err != nil {
		return nil, nil, err
	}
	return ip, ipnet, nil
}

func parseIP(s string) (net.IP, int, error) {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return nil, 0, fmt.Errorf("%q 不是合法 IP 地址", s)
	}
	if ip.To4() != nil {
		return ip.To4(), 4, nil
	}
	return ip, 6, nil
}

// validatePool 校验 Kea 地址池写法：范围 a-b 或前缀 a/len。
func validatePool(p string) error {
	p = strings.TrimSpace(p)
	if p == "" {
		return fmt.Errorf("地址池不能为空")
	}
	if strings.Contains(p, "-") {
		parts := strings.SplitN(p, "-", 2)
		start, s4, err := parseIP(parts[0])
		if err != nil {
			return fmt.Errorf("地址池起始地址不合法：%v", err)
		}
		end, e4, err := parseIP(parts[1])
		if err != nil {
			return fmt.Errorf("地址池结束地址不合法：%v", err)
		}
		if (s4 == 4) != (e4 == 4) {
			return fmt.Errorf("地址池首尾地址必须同属 IPv4")
		}
		if s4 != 4 {
			return fmt.Errorf("仅支持 IPv4 地址池")
		}
		if bytesCompare(end, start) < 0 {
			return fmt.Errorf("地址池结束地址不能小于起始地址")
		}
		return nil
	}
	if strings.Contains(p, "/") {
		_, ipnet, err := parseCIDR(p)
		if err != nil {
			return fmt.Errorf("地址池前缀不合法：%v", err)
		}
		if ipnet.IP.To4() == nil {
			return fmt.Errorf("仅支持 IPv4 地址池")
		}
		return nil
	}
	return fmt.Errorf("地址池格式应为 192.168.1.10-192.168.1.100 或 192.168.1.0/24")
}

func bytesCompare(a, b net.IP) int {
	a4, b4 := a.To4(), b.To4()
	if a4 == nil || b4 == nil {
		return 0
	}
	for i := 0; i < 4; i++ {
		if a4[i] < b4[i] {
			return -1
		}
		if a4[i] > b4[i] {
			return 1
		}
	}
	return 0
}
