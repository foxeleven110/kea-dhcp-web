package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"kea-dhcp-go/internal/api"
	"kea-dhcp-go/internal/config"
	"kea-dhcp-go/internal/kea"
)

//go:embed all:web
var webFS embed.FS

func main() {
	log.SetFlags(log.LstdFlags)

	addr := flag.String("addr", "", "监听地址，例如 127.0.0.1:8080")
	cfgPath := flag.String("config", "config.json", "配置文件路径")
	keaURL := flag.String("kea-url", "", "Kea Control Agent 地址")
	keaUser := flag.String("kea-user", "", "Kea API 用户名")
	keaPass := flag.String("kea-pass", "", "Kea API 密码")
	open := flag.Bool("open", true, "启动后自动打开浏览器")
	dev := flag.Bool("dev", false, "开发模式：前端资源从磁盘目录读取，修改后刷新即生效")
	webDir := flag.String("web", "web", "开发模式下的前端资源目录")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("读取配置失败：%v", err)
	}
	cfg.ApplyEnv()
	if *addr != "" {
		cfg.Listen = *addr
	}
	if *keaURL != "" {
		cfg.KeaURL = config.NormalizeURL(*keaURL)
	}
	if *keaUser != "" {
		cfg.KeaUser = *keaUser
	}
	if *keaPass != "" {
		cfg.KeaPass = *keaPass
	}
	cfg.OpenBrowser = *open

	if _, statErr := os.Stat(*cfgPath); errors.Is(statErr, fs.ErrNotExist) {
		if err := cfg.Save(*cfgPath); err == nil {
			log.Printf("已生成默认配置：%s", *cfgPath)
		}
	}

	client := kea.New(cfg.KeaURL, cfg.KeaUser, cfg.KeaPass)
	var ui fs.FS
	if *dev {
		ui = os.DirFS(*webDir)
		log.Printf("开发模式：前端资源来自 %s", *webDir)
	} else {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			log.Fatalf("加载前端资源失败：%v", err)
		}
		ui = sub
	}
	handler := api.New(client, &cfg, *cfgPath, ui).Handler()

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Fatalf("监听 %s 失败：%v", cfg.Listen, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	host := "127.0.0.1"
	if h, _, err := net.SplitHostPort(cfg.Listen); err == nil && h != "" && h != "0.0.0.0" && h != "::" {
		host = h
	}
	localURL := fmt.Sprintf("http://%s:%d", host, port)

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	fmt.Println("========================================")
	fmt.Println(" Kea DHCP 管理台")
	fmt.Printf(" 本机入口 : %s\n", localURL)
	fmt.Printf(" 监听地址 : %s\n", cfg.Listen)
	fmt.Printf(" Kea 地址 : %s\n", cfg.KeaURL)
	fmt.Println("========================================")
	log.Printf("服务已启动，运行平台 %s/%s", runtime.GOOS, runtime.GOARCH)

	if cfg.OpenBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openBrowser(localURL); err != nil {
				log.Printf("自动打开浏览器失败：%v，请手动访问 %s", err, localURL)
			}
		}()
	}

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务异常退出：%v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("正在关闭服务…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func openBrowser(url string) error {
	if os.Getenv("KEA_NO_BROWSER") != "" {
		return nil
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		if strings.TrimSpace(os.Getenv("DISPLAY")) == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return nil
		}
		return exec.Command("xdg-open", url).Start()
	}
}
