import { DATABASE_URL, PORT } from './config';
import { createPool } from './db';
import { buildApp } from './app';

const pool = createPool(DATABASE_URL);
const app = buildApp(pool);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
