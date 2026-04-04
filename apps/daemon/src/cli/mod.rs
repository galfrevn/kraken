pub mod audit_cmd;
pub mod channel_cmd;
pub mod clean_cmd;
pub mod config_cmd;
pub mod daemon_cmd;
pub mod doctor;
pub mod env_helpers;
pub mod init;
pub mod logs_cmd;
pub mod mcp_cmd;
pub mod notification_cmd;
pub mod output;
pub mod provider_cmd;
pub mod start;
pub mod stats_cmd;
pub mod status;
pub mod stop;
pub mod task_cmd;
pub mod trigger_cmd;
pub mod uninstall;
pub mod widget_cmd;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "kraken",
    version,
    about = "Autonomous developer agent",
    long_about = "Kraken is an autonomous developer agent that runs tasks, watches files, \
                  handles webhooks, and orchestrates work via an intelligent daemon."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Force JSON output regardless of terminal detection
    #[arg(long, global = true)]
    pub json: bool,

    /// Enable verbose logging to stderr
    #[arg(long, global = true)]
    pub verbose: bool,

    /// Resume the most recent session
    #[arg(long, short = 'c')]
    pub r#continue: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start the interactive TUI with the daemon
    #[command(
        long_about = "Starts the TUI application. Spawns the daemon in background unless --no-daemon is set.\nIf a daemon is already running, it will be reused."
    )]
    Start {
        /// Skip spawning daemon, only start TUI
        #[arg(long)]
        no_daemon: bool,
        /// Development mode with hot reload
        #[arg(long)]
        dev: bool,
    },

    /// Manage the background daemon
    #[command(
        subcommand,
        long_about = "Control the Kraken daemon: start it in background, run in foreground,\ncheck status, or stop it."
    )]
    Daemon(DaemonCommands),

    /// Initialize kraken in the current project
    #[command(
        long_about = "Interactive wizard that sets up Kraken: picks LLM provider, saves API key,\nconfigures triggers and notifications, and generates kraken.jsonc."
    )]
    Init {
        /// Skip prompts, create minimal config with defaults
        #[arg(long)]
        defaults: bool,
    },

    /// Manage configuration
    #[command(subcommand)]
    Config(ConfigCommands),

    /// Manage tasks
    #[command(subcommand)]
    Task(TaskCommands),

    /// Manage triggers
    #[command(subcommand)]
    Trigger(TriggerCommands),

    /// Manage notification channels
    #[command(subcommand)]
    Notification(NotificationCommands),

    /// Manage channel adapters (Telegram, etc.)
    #[command(subcommand)]
    Channel(ChannelCommands),

    /// Manage pairing requests for channel access
    #[command(subcommand)]
    Pairing(PairingCommands),

    /// Manage authorized channel users
    #[command(subcommand)]
    Users(UsersCommands),

    /// Manage MCP servers
    #[command(subcommand)]
    Mcp(McpCommands),

    /// Manage LLM providers and API keys
    #[command(subcommand)]
    Provider(ProviderCommands),

    /// Show usage statistics (tokens, costs, task counts)
    Stats {
        /// Time period: today, week, month
        #[arg(long, default_value = "today")]
        period: String,
    },

    /// Show daemon logs
    Logs {
        /// Stream logs in real-time
        #[arg(long)]
        follow: bool,
        /// Number of recent lines to show
        #[arg(long, default_value = "50")]
        lines: u32,
    },

    /// Clean up old worktrees and tasks
    Clean {
        /// Remove stale git worktrees (>7 days)
        #[arg(long)]
        worktrees: bool,
        /// Remove tasks older than N days (default: 30)
        #[arg(long)]
        tasks: Option<u32>,
        /// Preview what would be cleaned without deleting
        #[arg(long)]
        dry_run: bool,
    },

    /// Query the audit log of agent actions
    Audit {
        /// Filter by session ID
        #[arg(long)]
        session: Option<String>,
        /// Filter by target file path
        #[arg(long)]
        file: Option<String>,
        /// Filter by event type (e.g. tool_call, llm_call, command_execute)
        #[arg(long, name = "type")]
        event_type: Option<String>,
        /// Time filter (e.g. 24h, 7d, 30m)
        #[arg(long)]
        since: Option<String>,
        /// Show aggregated summary instead of events
        #[arg(long)]
        summary: bool,
        /// Max events to return
        #[arg(long)]
        limit: Option<i32>,
    },

    /// Run diagnostic checks on system health
    Doctor {
        /// Attempt to auto-fix fixable issues
        #[arg(long)]
        fix: bool,
    },

    /// Print the shell command to add kraken to your PATH
    SetupPath,

    /// Manage the iOS widget and tunnel
    #[command(subcommand)]
    Widget(WidgetCommands),

    /// Remove kraken configuration and data from this machine
    #[command(
        long_about = "Removes all Kraken data: ~/.kraken/ directory (config, database, logs, PID file),\nkraken.jsonc from current project, and .kraken-worktrees/ if present.\nUse --keep-global to only remove project-local files."
    )]
    Uninstall {
        /// Only remove project-local files (kraken.jsonc, .kraken-worktrees/), keep ~/.kraken/
        #[arg(long)]
        keep_global: bool,
        /// Skip confirmation prompt
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum DaemonCommands {
    /// Start the daemon in the background
    #[command(
        long_about = "Spawns the daemon as a detached background process and returns immediately.\nWaits up to 3s for healthcheck before returning."
    )]
    Start {
        /// Path to kraken.jsonc config file
        #[arg(long)]
        config: Option<String>,
        /// Override daemon HTTP port (default: 50051)
        #[arg(long)]
        port: Option<u16>,
    },

    /// Run the daemon in the foreground (blocks the terminal)
    #[command(
        long_about = "Runs the daemon process in the foreground. Used for Docker, systemd,\nor when you want to see logs directly in the terminal."
    )]
    Run {
        /// Path to kraken.jsonc config file
        #[arg(long)]
        config: Option<String>,
        /// Write logs to file instead of stderr
        #[arg(long)]
        log_file: Option<String>,
        /// Override daemon HTTP port (default: 50051)
        #[arg(long)]
        port: Option<u16>,
    },

    /// Stop the running daemon
    #[command(
        long_about = "Stops the running daemon gracefully. Reads PID from ~/.kraken/daemon.pid.\nUse --force to kill immediately after 5s grace period."
    )]
    Stop {
        /// Kill immediately after 5s grace period
        #[arg(long)]
        force: bool,
    },

    /// Show daemon status
    #[command(
        long_about = "Shows whether the daemon is running, its uptime, active workers, and task counts."
    )]
    Status,

    /// Reload daemon configuration without restarting
    #[command(
        long_about = "Tells the running daemon to re-read kraken.jsonc and apply changes\n(triggers, notifications, channels) without losing state or connections."
    )]
    Reload,
}

#[derive(Subcommand)]
pub enum ConfigCommands {
    /// Show current configuration (secrets redacted)
    Show,
    /// Print resolved config file path
    Path,
    /// Set a configuration value (dot notation)
    Set {
        /// Config key in dot notation (e.g. orchestrator.maxConcurrentTasks)
        key: String,
        /// Value to set
        value: String,
    },
    /// Get a configuration value
    Get {
        /// Config key in dot notation
        key: String,
    },
    /// Validate kraken.jsonc without starting anything
    Validate,
    /// Reload configuration on the running daemon
    Reload,
}

#[derive(Subcommand)]
pub enum TaskCommands {
    /// Create a new task
    Create {
        /// Task description / prompt
        prompt: String,
        /// Priority 0-10 (higher = dequeued first)
        #[arg(long, default_value = "5")]
        priority: i32,
        /// Agent ID to use
        #[arg(long, default_value = "build")]
        agent: String,
        /// Working directory for the task (defaults to current directory)
        #[arg(long)]
        workdir: Option<String>,
    },
    /// List tasks
    List {
        /// Filter by status: pending, running, completed, failed, cancelled, all
        #[arg(long, default_value = "all")]
        status: String,
        /// Max tasks to return
        #[arg(long, default_value = "20")]
        limit: i32,
        /// Skip first N tasks for pagination
        #[arg(long, default_value = "0")]
        offset: i32,
    },
    /// Show task details
    Show {
        /// Task ID (full UUID or unique prefix, min 6 chars)
        task_id: String,
    },
    /// Cancel a pending or running task
    Cancel {
        /// Task ID (full UUID or unique prefix)
        task_id: String,
    },
    /// Delete a pending task
    Delete {
        /// Task ID (full UUID or unique prefix)
        task_id: String,
    },
    /// Retry a failed or cancelled task
    Retry {
        /// Task ID (full UUID or unique prefix)
        task_id: String,
        /// Override agent for the retry
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show task logs
    Logs {
        /// Task ID (full UUID or unique prefix)
        task_id: String,
        /// Stream logs in real-time
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Subcommand)]
pub enum TriggerCommands {
    /// List configured triggers from kraken.jsonc
    List,
    /// Add a new trigger interactively
    Add {
        /// Trigger type: cron, watcher, webhook
        #[arg(long, short)]
        trigger_type: Option<String>,
    },
    /// Remove a trigger by name
    Remove {
        /// Trigger name to remove
        name: String,
    },
    /// Fire a trigger manually (requires running daemon)
    Test {
        /// Trigger name as defined in kraken.jsonc
        trigger_name: String,
    },
}

#[derive(Subcommand)]
pub enum NotificationCommands {
    /// List configured notification channels from kraken.jsonc
    List,
    /// Send a test notification (requires running daemon)
    Test {
        /// Channel name as defined in kraken.jsonc
        channel_name: String,
        /// Custom message
        #[arg(long, default_value = "Kraken test notification")]
        message: String,
    },
}

#[derive(Subcommand)]
pub enum ChannelCommands {
    /// List configured channel adapters and their status
    List,
    /// Show active channel sessions
    Sessions {
        /// Filter by channel type (e.g. telegram)
        #[arg(long)]
        channel_type: Option<String>,
    },
    /// Add a new channel adapter interactively
    Add {
        /// Channel type (e.g. telegram)
        #[arg(long, short)]
        channel_type: Option<String>,
    },
    /// Remove a channel adapter
    Remove {
        /// Channel type to remove (e.g. telegram)
        name: String,
    },
}

#[derive(Subcommand)]
pub enum PairingCommands {
    /// List pending pairing requests
    List {
        /// Channel type (e.g. telegram)
        channel: String,
    },
    /// Approve a pairing request by code
    Approve {
        /// Channel type (e.g. telegram)
        channel: String,
        /// Pairing code to approve
        code: String,
    },
    /// Reject a pairing request by code
    Reject {
        /// Channel type (e.g. telegram)
        channel: String,
        /// Pairing code to reject
        code: String,
    },
}

#[derive(Subcommand)]
pub enum UsersCommands {
    /// List authorized users
    List {
        /// Filter by channel type (e.g. telegram)
        #[arg(long)]
        channel: Option<String>,
    },
    /// Authorize a user directly by platform ID
    Add {
        /// Channel type (e.g. telegram)
        channel: String,
        /// Platform-specific user ID
        platform_id: String,
        /// Display name
        #[arg(long)]
        name: Option<String>,
    },
    /// Revoke a user's access
    Remove {
        /// Channel type (e.g. telegram)
        channel: String,
        /// Platform-specific user ID
        platform_id: String,
    },
}

#[derive(Subcommand)]
pub enum McpCommands {
    /// List configured MCP servers
    List,
    /// Add a new MCP server (local with --command, or remote with --url)
    Add {
        /// Unique server name
        name: String,
        /// Command to spawn (for local servers, e.g. "npx -y @modelcontextprotocol/server-sqlite db.sqlite")
        #[arg(long)]
        command: Option<String>,
        /// URL for remote servers
        #[arg(long)]
        url: Option<String>,
    },
    /// Remove an MCP server
    Remove {
        /// Server name to remove
        name: String,
    },
    /// Enable a disabled MCP server
    Enable {
        /// Server name to enable
        name: String,
    },
    /// Disable an MCP server without removing it
    Disable {
        /// Server name to disable
        name: String,
    },
}

#[derive(Subcommand)]
pub enum ProviderCommands {
    /// List available providers and their configuration status
    List,
    /// Configure a provider's API key (creates or overwrites)
    Configure {
        /// Provider name (e.g. openrouter)
        provider: String,
    },
    /// Remove a provider's API key
    Remove {
        /// Provider name (e.g. openrouter)
        provider: String,
    },
}

#[derive(Subcommand)]
pub enum WidgetCommands {
    /// Configure the iOS widget token and enable the widget API
    Setup,
    /// Show current widget status and tunnel info
    Status,
    /// Manage the Cloudflare tunnel
    #[command(subcommand)]
    Tunnel(TunnelCommands),
}

#[derive(Subcommand)]
pub enum TunnelCommands {
    /// Start the tunnel in background
    Start,
    /// Stop the running tunnel
    Stop,
}
