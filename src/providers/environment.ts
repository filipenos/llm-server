export function loginEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  // Only pass OS/session locations needed by official clients, never API-key overrides.
  for (const key of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SSH_AUTH_SOCK",
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}
