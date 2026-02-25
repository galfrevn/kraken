package webhooks

import (
	"io"
	"log/slog"
	"net/http"
	"strings"

	agentv1 "kraken/gen/go/agent/v1"
)

type EventChannel chan *agentv1.WebhookEvent

func NewHandler(store *Store, eventChannel EventChannel, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		webhookID := strings.TrimPrefix(r.URL.Path, "/webhooks/")
		if webhookID == "" {
			http.Error(w, "missing webhook id", http.StatusBadRequest)
			return
		}

		registration, exists := store.Get(webhookID)
		if !exists {
			http.Error(w, "webhook not found", http.StatusNotFound)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		eventType := detectEventType(r, registration.Provider)
		headers := extractRelevantHeaders(r)

		logger.Info("webhook received",
			"webhook_id", webhookID,
			"provider", registration.Provider,
			"event_type", eventType,
			"payload_size", len(body),
		)

		event := &agentv1.WebhookEvent{
			WebhookId: webhookID,
			Provider:  registration.Provider,
			EventType: eventType,
			Payload:   string(body),
			Headers:   headers,
		}

		select {
		case eventChannel <- event:
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"accepted"}`))
		default:
			logger.Warn("webhook event channel full, dropping event", "webhook_id", webhookID)
			http.Error(w, "event queue full", http.StatusServiceUnavailable)
		}
	}
}

func detectEventType(r *http.Request, provider string) string {
	switch provider {
	case "github":
		if eventHeader := r.Header.Get("X-GitHub-Event"); eventHeader != "" {
			return eventHeader
		}
	case "gitlab":
		if eventHeader := r.Header.Get("X-Gitlab-Event"); eventHeader != "" {
			return eventHeader
		}
	}
	return "unknown"
}

func extractRelevantHeaders(r *http.Request) map[string]string {
	headers := make(map[string]string)
	for _, key := range []string{
		"Content-Type",
		"X-GitHub-Event",
		"X-GitHub-Delivery",
		"X-Hub-Signature-256",
		"X-Gitlab-Event",
		"X-Gitlab-Token",
	} {
		if value := r.Header.Get(key); value != "" {
			headers[key] = value
		}
	}
	return headers
}
