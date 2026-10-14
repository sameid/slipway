import { app } from "./app.js";

// The platform sets PORT.
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`api listening on :${port} (release ${process.env.RELEASE ?? "dev"})`);
});
