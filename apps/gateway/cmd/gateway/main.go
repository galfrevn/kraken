package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"

	"kraken/apps/gateway/internal/api"
	"kraken/apps/gateway/internal/grpcserver"
	"kraken/apps/gateway/internal/llm"
	"kraken/apps/gateway/internal/webhooks"
	"kraken/gen/go/agent/v1/agentv1connect"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	loadEnvironmentFiles(logger)

	port := os.Getenv("GATEWAY_PORT")
	if port == "" {
		port = "50052"
	}

	llmClient := llm.NewClient()
	webhookStore := webhooks.NewStore()
	webhookEventChannel := make(webhooks.EventChannel, 256)

	gatewayServer := grpcserver.NewGatewayServer(llmClient, webhookStore, webhookEventChannel, logger)

	mux := http.NewServeMux()

	path, handler := agentv1connect.NewGatewayServiceHandler(gatewayServer)
	mux.Handle(path, handler)

	mux.HandleFunc("POST /webhooks/", webhooks.NewHandler(webhookStore, webhookEventChannel, logger))
	mux.HandleFunc("GET /health", api.HealthHandler())

	logger.Info("gateway service starting", "port", port)

	addr := fmt.Sprintf("0.0.0.0:%s", port)

	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	server.Protocols = p

	if err := server.ListenAndServe(); err != nil {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func loadEnvironmentFiles(logger *slog.Logger) {
	cwd, err := os.Getwd()
	if err != nil {
		return
	}

	candidates := []string{
		filepath.Join(cwd, ".env"),
		filepath.Join(cwd, "..", "..", ".env"),
	}

	for _, path := range candidates {
		if _, statErr := os.Stat(path); statErr == nil {
			if loadErr := godotenv.Load(path); loadErr == nil {
				logger.Info("loaded environment file", "path", path)
				return
			}
		}
	}
}
