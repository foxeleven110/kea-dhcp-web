package kea

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Kea 命令返回码
const (
	ResultSuccess     = 0
	ResultError       = 1
	ResultUnsupported = 2
	ResultEmpty       = 957 // 该版本未使用，保留语义
)

// Error 表示 Kea 返回的业务错误或传输错误。
type Error struct {
	Command string
	Result  int
	Text    string
	Status  int
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("调用 Kea 失败（%s）：%v", e.Command, e.Cause)
	}
	if e.Status != 0 && e.Status != http.StatusOK {
		return fmt.Sprintf("Kea 返回 HTTP %d（%s）：%s", e.Status, e.Command, e.Text)
	}
	return fmt.Sprintf("Kea 执行 %s 失败（result=%d）：%s", e.Command, e.Result, e.Text)
}

func (e *Error) Unwrap() error { return e.Cause }

// IsUnsupported 判断是否为“命令/钩子不支持”。
func IsUnsupported(err error) bool {
	var ke *Error
	if !asError(err, &ke) {
		return false
	}
	if ke.Result == ResultUnsupported {
		return true
	}
	t := strings.ToLower(ke.Text)
	return strings.Contains(t, "unsupported") || strings.Contains(t, "not supported") ||
		strings.Contains(t, "not loaded") || strings.Contains(t, "unknown command")
}

func asError(err error, target **Error) bool {
	for err != nil {
		if e, ok := err.(*Error); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// Response 是 Kea 单条命令响应。
type Response struct {
	Result    int             `json:"result"`
	Text      string          `json:"text"`
	Arguments json.RawMessage `json:"arguments"`
}

// Client 是并发安全的 Kea Control Agent 客户端。
type Client struct {
	mu      sync.RWMutex
	baseURL string
	user    string
	pass    string
	hc      *http.Client
}

func New(baseURL, user, pass string) *Client {
	return &Client{
		baseURL: normalize(baseURL),
		user:    user,
		pass:    pass,
		hc:      &http.Client{Timeout: 20 * time.Second},
	}
}

func normalize(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "http://" + u
	}
	return strings.TrimRight(u, "/")
}

// Connection 返回当前连接信息（不含密码）。
func (c *Client) Connection() (baseURL, user string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.baseURL, c.user
}

// SetConnection 热更新连接参数；password 为空表示沿用原密码。
func (c *Client) SetConnection(baseURL, user, password string) error {
	baseURL = normalize(baseURL)
	if baseURL == "" {
		return fmt.Errorf("Kea 地址不能为空")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return fmt.Errorf("Kea 地址不合法：%s", baseURL)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.baseURL = baseURL
	if user != "" {
		c.user = user
	}
	if password != "" {
		c.pass = password
	}
	return nil
}

// CloneWith 基于当前配置创建客户端；空字段沿用当前值。
func (c *Client) CloneWith(baseURL, user, password string) *Client {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if baseURL == "" {
		baseURL = c.baseURL
	}
	if user == "" {
		user = c.user
	}
	if password == "" {
		password = c.pass
	}
	return New(baseURL, user, password)
}

func (c *Client) snapshot() (string, string, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.baseURL, c.user, c.pass
}

type request struct {
	Command   string   `json:"command"`
	Service   []string `json:"service,omitempty"`
	Arguments any      `json:"arguments,omitempty"`
}

// Exec 执行命令并返回原始响应（不因 result != 0 报错），用于命令控制台。
func (c *Client) Exec(ctx context.Context, command string, service []string, args any) (*Response, error) {
	baseURL, user, pass := c.snapshot()
	if baseURL == "" {
		return nil, &Error{Command: command, Text: "未配置 Kea 地址", Cause: fmt.Errorf("地址为空")}
	}
	body, err := json.Marshal(request{Command: command, Service: service, Arguments: args})
	if err != nil {
		return nil, &Error{Command: command, Cause: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/", bytes.NewReader(body))
	if err != nil {
		return nil, &Error{Command: command, Cause: err}
	}
	req.Header.Set("Content-Type", "application/json")
	if user != "" || pass != "" {
		req.SetBasicAuth(user, pass)
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, &Error{Command: command, Cause: friendlyNetErr(err)}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, &Error{Command: command, Status: resp.StatusCode, Cause: err}
	}
	if resp.StatusCode != http.StatusOK {
		text := strings.TrimSpace(string(data))
		if len(text) > 300 {
			text = text[:300]
		}
		if resp.StatusCode == http.StatusUnauthorized {
			text = "认证失败，请检查用户名和密码"
		}
		return nil, &Error{Command: command, Status: resp.StatusCode, Text: text}
	}

	var list []Response
	if err := json.Unmarshal(data, &list); err != nil {
		text := strings.TrimSpace(string(data))
		if len(text) > 300 {
			text = text[:300]
		}
		return nil, &Error{Command: command, Status: resp.StatusCode, Text: "响应不是合法 JSON 数组：" + text, Cause: err}
	}
	if len(list) == 0 {
		return nil, &Error{Command: command, Status: resp.StatusCode, Text: "响应为空数组"}
	}
	return &list[0], nil
}

// Call 执行命令，result != 0 时返回 *Error。
func (c *Client) Call(ctx context.Context, command string, service []string, args any) (json.RawMessage, error) {
	resp, err := c.Exec(ctx, command, service, args)
	if err != nil {
		return nil, err
	}
	if resp.Result != ResultSuccess {
		return nil, &Error{Command: command, Result: resp.Result, Text: resp.Text}
	}
	return resp.Arguments, nil
}

func friendlyNetErr(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return fmt.Errorf("连接被拒绝，请确认 Kea Control Agent 已启动并监听该端口")
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
		return fmt.Errorf("连接超时，请检查网络可达性与防火墙")
	case strings.Contains(msg, "no such host"):
		return fmt.Errorf("域名无法解析")
	}
	return err
}
