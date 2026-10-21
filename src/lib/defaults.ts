// Starting values for new connections and SSH hosts.
import type { ConnectionConfig, SshHost } from "./api";

export const COLORS = ["#5b8cff", "#4cc38a", "#e7b350", "#f26d6d", "#b07cff", "#3fc1c9", "#ff8a4c", "#8a92a0"];

export const blankConnection = (): ConnectionConfig => ({
  id: "",
  name: "",
  host: "localhost",
  port: 5432,
  user: "postgres",
  database: "postgres",
  sslMode: "prefer",
  color: COLORS[0],
  savePassword: true,
  showSystemSchemas: false,
});

export const blankSshHost = (): SshHost => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  user: "",
  auth: "password",
  keyPath: "",
  color: COLORS[1],
  saveSecret: true,
});
