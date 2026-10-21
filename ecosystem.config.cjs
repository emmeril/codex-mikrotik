module.exports = {
  apps: [
    {
      name: "mikrotik-telegram",
      cwd: "/root/codex-mikrotik",
      script: "dist/telegram.js",
      interpreter: "node",
      node_args: ["--env-file=/root/codex-mikrotik/.env"],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5_000,
      kill_timeout: 15_000,
      max_memory_restart: "300M",
      time: true,
      filter_env: ["OPENAI_", "ANTHROPIC_"],
      env_production: {
        NODE_ENV: "production",
        CODEX_BIN: "/root/.local/bin/codex",
      },
    },
  ],
};
