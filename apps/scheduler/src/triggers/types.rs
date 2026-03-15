use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const TEMPLATE_MAX_VALUE_LENGTH: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TriggerType {
    Cron,
    FileChange,
    Webhook,
    SlashCommand,
}

impl std::fmt::Display for TriggerType {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TriggerType::Cron => write!(formatter, "cron"),
            TriggerType::FileChange => write!(formatter, "file_change"),
            TriggerType::Webhook => write!(formatter, "webhook"),
            TriggerType::SlashCommand => write!(formatter, "slash_command"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TriggerEvent {
    pub id: String,
    pub trigger_type: TriggerType,
    pub source: String,
    pub payload: Value,
    pub fired_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FilterOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Matches,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerFilter {
    pub field: String,
    pub operator: FilterOperator,
    pub value: String,
}

impl TriggerFilter {
    pub fn parse(filter_string: &str) -> Result<Self, String> {
        let trimmed_input = filter_string.trim();
        if trimmed_input.is_empty() {
            return Err("filter string is empty".to_string());
        }

        let operator_keywords: &[(&str, FilterOperator)] = &[
            ("not_contains", FilterOperator::NotContains),
            ("not_equals", FilterOperator::NotEquals),
            ("starts_with", FilterOperator::StartsWith),
            ("ends_with", FilterOperator::EndsWith),
            ("contains", FilterOperator::Contains),
            ("matches", FilterOperator::Matches),
            ("equals", FilterOperator::Equals),
        ];

        for (keyword, operator_variant) in operator_keywords {
            if let Some(keyword_position) = trimmed_input.find(keyword) {
                let field_portion = trimmed_input[..keyword_position].trim();
                let value_portion = trimmed_input[keyword_position + keyword.len()..].trim();

                if field_portion.is_empty() {
                    return Err(format!("missing field before operator '{keyword}'"));
                }

                let unquoted_value = strip_surrounding_quotes(value_portion);

                return Ok(TriggerFilter {
                    field: field_portion.to_string(),
                    operator: operator_variant.clone(),
                    value: unquoted_value,
                });
            }
        }

        Err(format!(
            "no recognized operator found in filter string: '{trimmed_input}'"
        ))
    }

    pub fn evaluate(&self, payload: &Value) -> bool {
        let resolved_value = resolve_dot_notation_path(&self.field, payload);

        match resolved_value {
            None => false,
            Some(field_value) => self.apply_operator(&field_value),
        }
    }

    fn apply_operator(&self, field_value: &Value) -> bool {
        match &self.operator {
            FilterOperator::Equals => value_as_string(field_value) == self.value,
            FilterOperator::NotEquals => value_as_string(field_value) != self.value,
            FilterOperator::Contains => self.evaluate_contains(field_value),
            FilterOperator::NotContains => !self.evaluate_contains(field_value),
            FilterOperator::StartsWith => {
                value_as_string(field_value).starts_with(&self.value)
            }
            FilterOperator::EndsWith => {
                value_as_string(field_value).ends_with(&self.value)
            }
            FilterOperator::Matches => {
                match Regex::new(&self.value) {
                    Ok(compiled_regex) => {
                        compiled_regex.is_match(&value_as_string(field_value))
                    }
                    Err(_) => false,
                }
            }
        }
    }

    fn evaluate_contains(&self, field_value: &Value) -> bool {
        if let Some(array_elements) = field_value.as_array() {
            return array_elements.iter().any(|element| {
                value_as_string(element) == self.value
            });
        }
        value_as_string(field_value).contains(&self.value)
    }
}

fn strip_surrounding_quotes(input: &str) -> String {
    let trimmed = input.trim();
    if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
    {
        if trimmed.len() >= 2 {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn value_as_string(json_value: &Value) -> String {
    match json_value {
        Value::String(string_content) => string_content.clone(),
        Value::Null => String::new(),
        Value::Bool(boolean_value) => boolean_value.to_string(),
        Value::Number(numeric_value) => numeric_value.to_string(),
        other => other.to_string(),
    }
}

fn resolve_dot_notation_path<'a>(dot_path: &str, root_value: &'a Value) -> Option<&'a Value> {
    let path_segments: Vec<&str> = dot_path.split('.').collect();
    let mut current_value = root_value;

    for segment in &path_segments {
        match current_value {
            Value::Object(object_map) => {
                current_value = object_map.get(*segment)?;
            }
            Value::Array(array_elements) => {
                let array_index: usize = segment.parse().ok()?;
                current_value = array_elements.get(array_index)?;
            }
            _ => return None,
        }
    }

    Some(current_value)
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

pub fn render_template(template: &str, payload: &Value) -> String {
    let mut rendered_output = String::with_capacity(template.len());
    let template_bytes = template.as_bytes();
    let template_length = template_bytes.len();
    let mut cursor_position = 0;

    while cursor_position < template_length {
        if cursor_position + 1 < template_length
            && template_bytes[cursor_position] == b'{'
            && template_bytes[cursor_position + 1] == b'{'
        {
            let placeholder_content_start = cursor_position + 2;
            if let Some(closing_brace_offset) = template[placeholder_content_start..]
                .find("}}")
            {
                let placeholder_expression =
                    &template[placeholder_content_start..placeholder_content_start + closing_brace_offset];
                let trimmed_expression = placeholder_expression.trim();

                let resolved_text = if let Some(payload_path) = trimmed_expression.strip_prefix("event.") {
                    match resolve_dot_notation_path(payload_path, payload) {
                        Some(resolved_value) => {
                            let full_string = value_as_string(resolved_value);
                            if full_string.len() > TEMPLATE_MAX_VALUE_LENGTH {
                                full_string[..TEMPLATE_MAX_VALUE_LENGTH].to_string()
                            } else {
                                full_string
                            }
                        }
                        None => String::new(),
                    }
                } else {
                    String::new()
                };

                rendered_output.push_str(&resolved_text);
                cursor_position = placeholder_content_start + closing_brace_offset + 2;
            } else {
                rendered_output.push('{');
                cursor_position += 1;
            }
        } else {
            rendered_output.push(template[cursor_position..].chars().next().unwrap());
            cursor_position += template[cursor_position..].chars().next().unwrap().len_utf8();
        }
    }

    rendered_output
}

// ---------------------------------------------------------------------------
// Config types (loaded from YAML)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTriggerConfig {
    pub name: String,
    pub provider: String,
    pub secret: String,
    pub events: Vec<WebhookEventConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookEventConfig {
    pub event_type: String,
    pub filters: Vec<TriggerFilter>,
    pub task_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronTriggerConfig {
    pub name: String,
    pub expression: String,
    pub task_template: String,
    pub branch_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherTriggerConfig {
    pub name: String,
    pub paths: Vec<String>,
    pub ignore_patterns: Vec<String>,
    pub debounce_ms: u32,
    pub task_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommandTriggerConfig {
    pub name: String,
    pub provider: String,
    pub token: String,
    #[serde(default)]
    pub app_token: Option<String>,
    pub channel: String,
    pub task_template: String,
    #[serde(default = "default_mention_keyword")]
    pub mention: String,
}

fn default_mention_keyword() -> String {
    "@kraken".to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -- Filter parsing tests ------------------------------------------------

    #[test]
    fn test_parse_filter_equals() {
        let filter = TriggerFilter::parse("status equals 'open'").unwrap();
        assert_eq!(filter.field, "status");
        assert_eq!(filter.operator, FilterOperator::Equals);
        assert_eq!(filter.value, "open");
    }

    #[test]
    fn test_parse_filter_not_equals() {
        let filter = TriggerFilter::parse("action not_equals 'closed'").unwrap();
        assert_eq!(filter.field, "action");
        assert_eq!(filter.operator, FilterOperator::NotEquals);
        assert_eq!(filter.value, "closed");
    }

    #[test]
    fn test_parse_filter_contains() {
        let filter = TriggerFilter::parse("labels contains 'kraken'").unwrap();
        assert_eq!(filter.field, "labels");
        assert_eq!(filter.operator, FilterOperator::Contains);
        assert_eq!(filter.value, "kraken");
    }

    #[test]
    fn test_parse_filter_not_contains() {
        let filter = TriggerFilter::parse("labels not_contains 'wip'").unwrap();
        assert_eq!(filter.field, "labels");
        assert_eq!(filter.operator, FilterOperator::NotContains);
        assert_eq!(filter.value, "wip");
    }

    #[test]
    fn test_parse_filter_starts_with() {
        let filter = TriggerFilter::parse("branch starts_with 'feature/'").unwrap();
        assert_eq!(filter.field, "branch");
        assert_eq!(filter.operator, FilterOperator::StartsWith);
        assert_eq!(filter.value, "feature/");
    }

    #[test]
    fn test_parse_filter_ends_with() {
        let filter = TriggerFilter::parse("file ends_with '.rs'").unwrap();
        assert_eq!(filter.field, "file");
        assert_eq!(filter.operator, FilterOperator::EndsWith);
        assert_eq!(filter.value, ".rs");
    }

    #[test]
    fn test_parse_filter_matches() {
        let filter = TriggerFilter::parse("title matches '^fix:'").unwrap();
        assert_eq!(filter.field, "title");
        assert_eq!(filter.operator, FilterOperator::Matches);
        assert_eq!(filter.value, "^fix:");
    }

    #[test]
    fn test_parse_filter_double_quotes() {
        let filter = TriggerFilter::parse(r#"name equals "hello world""#).unwrap();
        assert_eq!(filter.value, "hello world");
    }

    #[test]
    fn test_parse_filter_no_quotes() {
        let filter = TriggerFilter::parse("name equals open").unwrap();
        assert_eq!(filter.value, "open");
    }

    #[test]
    fn test_parse_filter_empty_string_error() {
        let result = TriggerFilter::parse("");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_filter_no_operator_error() {
        let result = TriggerFilter::parse("just some text");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_filter_extra_whitespace() {
        let filter = TriggerFilter::parse("  status   equals   'open'  ").unwrap();
        assert_eq!(filter.field, "status");
        assert_eq!(filter.value, "open");
    }

    // -- Filter evaluation tests ---------------------------------------------

    #[test]
    fn test_evaluate_equals_match() {
        let filter = TriggerFilter {
            field: "action".to_string(),
            operator: FilterOperator::Equals,
            value: "opened".to_string(),
        };
        let payload = json!({"action": "opened"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_equals_no_match() {
        let filter = TriggerFilter {
            field: "action".to_string(),
            operator: FilterOperator::Equals,
            value: "closed".to_string(),
        };
        let payload = json!({"action": "opened"});
        assert!(!filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_not_equals() {
        let filter = TriggerFilter {
            field: "action".to_string(),
            operator: FilterOperator::NotEquals,
            value: "closed".to_string(),
        };
        let payload = json!({"action": "opened"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_contains_string() {
        let filter = TriggerFilter {
            field: "title".to_string(),
            operator: FilterOperator::Contains,
            value: "bug".to_string(),
        };
        let payload = json!({"title": "fix a bug in parser"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_contains_array() {
        let filter = TriggerFilter {
            field: "labels".to_string(),
            operator: FilterOperator::Contains,
            value: "kraken".to_string(),
        };
        let payload = json!({"labels": ["bug", "kraken", "urgent"]});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_contains_array_no_match() {
        let filter = TriggerFilter {
            field: "labels".to_string(),
            operator: FilterOperator::Contains,
            value: "enhancement".to_string(),
        };
        let payload = json!({"labels": ["bug", "kraken"]});
        assert!(!filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_not_contains() {
        let filter = TriggerFilter {
            field: "labels".to_string(),
            operator: FilterOperator::NotContains,
            value: "wip".to_string(),
        };
        let payload = json!({"labels": ["bug", "kraken"]});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_starts_with() {
        let filter = TriggerFilter {
            field: "ref".to_string(),
            operator: FilterOperator::StartsWith,
            value: "refs/heads/".to_string(),
        };
        let payload = json!({"ref": "refs/heads/main"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_ends_with() {
        let filter = TriggerFilter {
            field: "file".to_string(),
            operator: FilterOperator::EndsWith,
            value: ".rs".to_string(),
        };
        let payload = json!({"file": "src/main.rs"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_matches_regex() {
        let filter = TriggerFilter {
            field: "title".to_string(),
            operator: FilterOperator::Matches,
            value: r"^(fix|feat):".to_string(),
        };
        let payload = json!({"title": "fix: resolve crash"});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_matches_regex_no_match() {
        let filter = TriggerFilter {
            field: "title".to_string(),
            operator: FilterOperator::Matches,
            value: r"^(fix|feat):".to_string(),
        };
        let payload = json!({"title": "chore: update deps"});
        assert!(!filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_matches_invalid_regex() {
        let filter = TriggerFilter {
            field: "title".to_string(),
            operator: FilterOperator::Matches,
            value: r"[invalid".to_string(),
        };
        let payload = json!({"title": "anything"});
        assert!(!filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_missing_field_returns_false() {
        let filter = TriggerFilter {
            field: "nonexistent".to_string(),
            operator: FilterOperator::Equals,
            value: "x".to_string(),
        };
        let payload = json!({"action": "opened"});
        assert!(!filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_numeric_equals() {
        let filter = TriggerFilter {
            field: "count".to_string(),
            operator: FilterOperator::Equals,
            value: "42".to_string(),
        };
        let payload = json!({"count": 42});
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_evaluate_boolean_equals() {
        let filter = TriggerFilter {
            field: "draft".to_string(),
            operator: FilterOperator::Equals,
            value: "false".to_string(),
        };
        let payload = json!({"draft": false});
        assert!(filter.evaluate(&payload));
    }

    // -- Dot-notation traversal tests ----------------------------------------

    #[test]
    fn test_dot_notation_nested_object() {
        let filter = TriggerFilter {
            field: "issue.title".to_string(),
            operator: FilterOperator::Equals,
            value: "crash on startup".to_string(),
        };
        let payload = json!({
            "issue": {
                "title": "crash on startup",
                "number": 42
            }
        });
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_dot_notation_deeply_nested() {
        let filter = TriggerFilter {
            field: "pull_request.head.ref".to_string(),
            operator: FilterOperator::StartsWith,
            value: "feature/".to_string(),
        };
        let payload = json!({
            "pull_request": {
                "head": {
                    "ref": "feature/new-ui"
                }
            }
        });
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_dot_notation_array_index() {
        let filter = TriggerFilter {
            field: "items.0.name".to_string(),
            operator: FilterOperator::Equals,
            value: "first".to_string(),
        };
        let payload = json!({
            "items": [
                {"name": "first"},
                {"name": "second"}
            ]
        });
        assert!(filter.evaluate(&payload));
    }

    #[test]
    fn test_dot_notation_missing_intermediate_field() {
        let filter = TriggerFilter {
            field: "a.b.c".to_string(),
            operator: FilterOperator::Equals,
            value: "x".to_string(),
        };
        let payload = json!({"a": {"z": 1}});
        assert!(!filter.evaluate(&payload));
    }

    // -- Template rendering tests --------------------------------------------

    #[test]
    fn test_render_template_simple() {
        let payload = json!({"issue": {"title": "Fix login bug"}});
        let rendered = render_template("Fix: {{event.issue.title}}", &payload);
        assert_eq!(rendered, "Fix: Fix login bug");
    }

    #[test]
    fn test_render_template_multiple_placeholders() {
        let payload = json!({"repo": "kraken", "number": 42});
        let rendered = render_template(
            "PR #{{event.number}} in {{event.repo}}",
            &payload,
        );
        assert_eq!(rendered, "PR #42 in kraken");
    }

    #[test]
    fn test_render_template_missing_field_renders_empty() {
        let payload = json!({"action": "opened"});
        let rendered = render_template("Value: {{event.missing}}", &payload);
        assert_eq!(rendered, "Value: ");
    }

    #[test]
    fn test_render_template_no_placeholders() {
        let payload = json!({});
        let rendered = render_template("plain text", &payload);
        assert_eq!(rendered, "plain text");
    }

    #[test]
    fn test_render_template_truncates_long_values() {
        let long_string = "x".repeat(8192);
        let payload = json!({"data": long_string});
        let rendered = render_template("{{event.data}}", &payload);
        assert_eq!(rendered.len(), TEMPLATE_MAX_VALUE_LENGTH);
    }

    #[test]
    fn test_render_template_unclosed_braces() {
        let payload = json!({"a": "b"});
        let rendered = render_template("start {{event.a and no close", &payload);
        assert_eq!(rendered, "start {{event.a and no close");
    }

    #[test]
    fn test_render_template_nested_path() {
        let payload = json!({"pull_request": {"head": {"ref": "feature/x"}}});
        let rendered = render_template(
            "Branch: {{event.pull_request.head.ref}}",
            &payload,
        );
        assert_eq!(rendered, "Branch: feature/x");
    }

    #[test]
    fn test_render_template_without_event_prefix_renders_empty() {
        let payload = json!({"name": "test"});
        let rendered = render_template("{{name}}", &payload);
        assert_eq!(rendered, "");
    }
}
