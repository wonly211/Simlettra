import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/数据库结构.ts",
  out: "./migrations"
});
