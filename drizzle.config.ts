import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/database/schema.ts',
  out: './验证性原型/Drizzle迁移草案',
})
