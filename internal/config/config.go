package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config 是进程启动配置。密码只保存在本地配置文件（0600）或环境变量中。
type Config struct {
	Listen      string `json:"listen"`
	KeaURL      string `json:"kea_url"`
	KeaUser     string `json:"kea_user"`
	KeaPass     string `json:"kea_pass"`
	OpenBrowser bool   `json:"open_browser"`
}

func Default() Config {
	return Config{
		Listen:      "127.0.0.1:8080",
		KeaURL:      "http://192.168.6.94:8000",
		KeaUser:     "admin",
		KeaPass:     "admin@123",
		OpenBrowser: true,
	}
}

// Load 读取配置文件。文件不存在时返回默认配置且不报错。
func Load(path string) (Config, error) {
	cfg := Default()
	if path == "" {
		return cfg, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	cfg.normalize()
	return cfg, nil
}

// ApplyEnv 用环境变量覆盖配置，便于容器部署。
func (c *Config) ApplyEnv() {
	if v := os.Getenv("KEA_LISTEN"); v != "" {
		c.Listen = v
	}
	if v := os.Getenv("KEA_URL"); v != "" {
		c.KeaURL = strings.TrimSpace(v)
	}
	if v := os.Getenv("KEA_USER"); v != "" {
		c.KeaUser = v
	}
	if v := os.Getenv("KEA_PASS"); v != "" {
		c.KeaPass = v
	}
	if v := os.Getenv("KEA_OPEN_BROWSER"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			c.OpenBrowser = b
		}
	}
	c.normalize()
}

func (c *Config) normalize() {
	c.KeaURL = NormalizeURL(c.KeaURL)
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8080"
	}
}

// NormalizeURL 补全协议并去掉末尾斜杠。
func NormalizeURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "http://" + u
	}
	return strings.TrimRight(u, "/")
}

// Save 以 0600 权限保存配置（包含凭证，仅限本机）。
func (c *Config) Save(path string) error {
	if path == "" {
		return errors.New("未指定配置文件路径")
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
