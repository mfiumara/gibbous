// Gibbous for Windows and Linux. All the work is in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gibbous_lib::run()
}
