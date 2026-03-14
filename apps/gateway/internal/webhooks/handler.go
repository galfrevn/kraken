package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
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

		if err := validateSignature(body, registration, r.Header); err != nil {
			logger.Warn("webhook signature validation failed", "webhook_id", webhookID, "provider", registration.Provider, "error", err)
			http.Error(w, "signature validation failed", http.StatusUnauthorized)
			return
		}

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

func validateSignature(body []byte, registration *Registration, headers http.Header) error {
	if registration.Secret == "" {
		return nil
	}
	switch registration.Provider {
	case "github":
		return validateGitHubSignature(body, registration.Secret, headers)
	case "gitlab":
		return validateGitLabToken(registration.Secret, headers)
	default:
		return nil
	}
}

func validateGitHubSignature(body []byte, secret string, headers http.Header) error {
	sigHeader := headers.Get("X-Hub-Signature-256")
	if sigHeader == "" {
		return fmt.Errorf("missing X-Hub-Signature-256 header")
	}
	if !strings.HasPrefix(sigHeader, "sha256=") {
		return fmt.Errorf("invalid signature format: expected sha256= prefix")
	}
	sigHex := strings.TrimPrefix(sigHeader, "sha256=")
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("invalid signature hex encoding: %w", err)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := mac.Sum(nil)
	if !hmac.Equal(sig, expected) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}

func validateGitLabToken(secret string, headers http.Header) error {
	token := headers.Get("X-Gitlab-Token")
	if token == "" {
		return fmt.Errorf("missing X-Gitlab-Token header")
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(secret)) != 1 {
		return fmt.Errorf("token mismatch")
	}
	return nil
}
