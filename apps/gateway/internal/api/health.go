package api

import (
	"encoding/json"
	"net/http"
)

type HealthResponse struct {
	Status  string          `json:"status"`
	Version string          `json:"version"`
	Services map[string]bool `json:"services"`
}

func HealthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := HealthResponse{
			Status:  "healthy",
			Version: "0.1.0",
			Services: map[string]bool{
				"gateway": true,
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}
