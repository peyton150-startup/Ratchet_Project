import dotenv from 'dotenv';
dotenv.config();

// Application (non-owner) connection — RLS is enforced on this role.
export const DATABASE_URL = process.env.DATABASE_URL;
// Admin/superuser connection — used only for migrations, never on the request path.
export const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
export const PORT = Number(process.env.PORT ?? 3000);
