use reqwest::Client;
use serde_json::Value;
use tracing::debug;

const GITHUB_API_BASE: &str = "https://api.github.com";

pub struct GitHubClient {
    token: String,
    http: Client,
}

impl GitHubClient {
    pub fn new(token: String) -> Self {
        Self {
            token,
            http: Client::new(),
        }
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{GITHUB_API_BASE}{path}");
        debug!(url = %url, "github GET");
        let response = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "kraken")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("github request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("github API error ({status}): {body}"));
        }

        response
            .json()
            .await
            .map_err(|e| format!("failed to parse github response: {e}"))
    }

    #[allow(dead_code)]
    async fn get_text(&self, path: &str) -> Result<String, String> {
        let url = format!("{GITHUB_API_BASE}{path}");
        debug!(url = %url, "github GET text");
        let response = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github.v3.diff")
            .header("User-Agent", "kraken")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("github request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("github API error ({status}): {body}"));
        }

        response
            .text()
            .await
            .map_err(|e| format!("failed to read github response: {e}"))
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{GITHUB_API_BASE}{path}");
        debug!(url = %url, "github POST");
        let response = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "kraken")
            .timeout(std::time::Duration::from_secs(15))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("github request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("github API error ({status}): {body}"));
        }

        response
            .json()
            .await
            .map_err(|e| format!("failed to parse github response: {e}"))
    }

    async fn put(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{GITHUB_API_BASE}{path}");
        debug!(url = %url, "github PUT");
        let response = self
            .http
            .put(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "kraken")
            .timeout(std::time::Duration::from_secs(15))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("github request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("github API error ({status}): {body}"));
        }

        response
            .json()
            .await
            .map_err(|e| format!("failed to parse github response: {e}"))
    }

    // ── Pull Requests ─────────────────────────────────────────────────

    pub async fn list_prs(&self, repo: &str, state: &str) -> Result<Vec<Value>, String> {
        let result = self
            .get(&format!("/repos/{repo}/pulls?state={state}&per_page=30"))
            .await?;
        result
            .as_array()
            .cloned()
            .ok_or_else(|| "unexpected response format".to_string())
    }

    pub async fn get_pr(&self, repo: &str, number: u64) -> Result<Value, String> {
        self.get(&format!("/repos/{repo}/pulls/{number}")).await
    }

    #[allow(dead_code)]
    pub async fn get_pr_diff(&self, repo: &str, number: u64) -> Result<String, String> {
        self.get_text(&format!("/repos/{repo}/pulls/{number}"))
            .await
    }

    pub async fn create_pr(
        &self,
        repo: &str,
        title: &str,
        body: &str,
        head: &str,
        base: &str,
    ) -> Result<Value, String> {
        self.post(
            &format!("/repos/{repo}/pulls"),
            &serde_json::json!({
                "title": title,
                "body": body,
                "head": head,
                "base": base,
            }),
        )
        .await
    }

    pub async fn merge_pr(&self, repo: &str, number: u64) -> Result<Value, String> {
        self.put(
            &format!("/repos/{repo}/pulls/{number}/merge"),
            &serde_json::json!({}),
        )
        .await
    }

    pub async fn create_pr_comment(
        &self,
        repo: &str,
        number: u64,
        body: &str,
    ) -> Result<Value, String> {
        self.post(
            &format!("/repos/{repo}/issues/{number}/comments"),
            &serde_json::json!({ "body": body }),
        )
        .await
    }

    // ── Issues ────────────────────────────────────────────────────────

    pub async fn list_issues(&self, repo: &str, state: &str) -> Result<Vec<Value>, String> {
        let result = self
            .get(&format!(
                "/repos/{repo}/issues?state={state}&per_page=30&sort=updated"
            ))
            .await?;
        result
            .as_array()
            .cloned()
            .ok_or_else(|| "unexpected response format".to_string())
    }

    #[allow(dead_code)]
    pub async fn get_issue(&self, repo: &str, number: u64) -> Result<Value, String> {
        self.get(&format!("/repos/{repo}/issues/{number}")).await
    }

    pub async fn create_issue(&self, repo: &str, title: &str, body: &str) -> Result<Value, String> {
        self.post(
            &format!("/repos/{repo}/issues"),
            &serde_json::json!({ "title": title, "body": body }),
        )
        .await
    }

    pub async fn create_issue_comment(
        &self,
        repo: &str,
        number: u64,
        body: &str,
    ) -> Result<Value, String> {
        self.post(
            &format!("/repos/{repo}/issues/{number}/comments"),
            &serde_json::json!({ "body": body }),
        )
        .await
    }

    #[allow(dead_code)]
    pub async fn add_labels(
        &self,
        repo: &str,
        number: u64,
        labels: &[String],
    ) -> Result<Value, String> {
        self.post(
            &format!("/repos/{repo}/issues/{number}/labels"),
            &serde_json::json!({ "labels": labels }),
        )
        .await
    }

    // ── Repository ───────────────────────────────────────────────────

    #[allow(dead_code)]
    pub async fn list_branches(&self, repo: &str) -> Result<Vec<Value>, String> {
        let result = self
            .get(&format!("/repos/{repo}/branches?per_page=30"))
            .await?;
        result
            .as_array()
            .cloned()
            .ok_or_else(|| "unexpected response format".to_string())
    }

    #[allow(dead_code)]
    pub async fn compare(&self, repo: &str, base: &str, head: &str) -> Result<Value, String> {
        self.get(&format!("/repos/{repo}/compare/{base}...{head}"))
            .await
    }
}
