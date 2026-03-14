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

	llmClient, err := llm.NewProviderRouterFromEnv()
	if err != nil {
		logger.Error("failed to create LLM client", "error", err)
		os.Exit(1)
	}
	logger.Info("LLM provider router initialized", "default_provider", os.Getenv("LLM_PROVIDER"))

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
	// Prefer DOTENV_PATH set by the CLI (points to ~/.kraken/.env)
	if dotenvPath := os.Getenv("DOTENV_PATH"); dotenvPath != "" {
		if _, statErr := os.Stat(dotenvPath); statErr == nil {
			if loadErr := godotenv.Load(dotenvPath); loadErr == nil {
				logger.Info("loaded environment file", "path", dotenvPath)
				return
			}
		}
	}

	// Fallback: try ~/.kraken/.env directly
	if home, err := os.UserHomeDir(); err == nil {
		krakenEnv := filepath.Join(home, ".kraken", ".env")
		if _, statErr := os.Stat(krakenEnv); statErr == nil {
			if loadErr := godotenv.Load(krakenEnv); loadErr == nil {
				logger.Info("loaded environment file", "path", krakenEnv)
				return
			}
		}
	}
}
