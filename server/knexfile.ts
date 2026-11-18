import type { Knex } from 'knex';
import dotenv from 'dotenv';

dotenv.config();

const config: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: './src/migrations',
      extension: 'ts',
    },
  },
  test: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: './src/migrations',
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    // DATABASE_URL when provided; otherwise the same DB_* variables the API
    // itself reads (composition/config.ts) — the ECS task definition supplies
    // DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD, never DATABASE_URL, so a
    // DATABASE_URL-only production profile could never connect to migrate.
    connection: process.env.DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    },
    pool: { min: 2, max: 20 },
    migrations: {
      directory: './src/migrations',
      extension: 'ts',
    },
  },
};

export default config;
