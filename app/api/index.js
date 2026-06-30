// Vercel serverless entry point. The Express app is itself a (req,res) handler,
// so we just re-export it. All routes are rewritten to this function (see
// vercel.json), so the function serves both the API and the static pages.
import app from '../server/index.js';
export default app;
