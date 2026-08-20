import "./styles.css";

if (window.location.pathname === "/") {
  void import("./home");
} else {
  void import("./dashboard-app");
}
