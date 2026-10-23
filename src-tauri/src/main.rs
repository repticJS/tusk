// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude starts Tusk with --mcp to talk to the running app.
    if std::env::args().any(|a| a == "--mcp") {
        return tusk_lib::mcp_bridge();
    }
    tusk_lib::run()
}
