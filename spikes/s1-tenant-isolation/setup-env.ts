// s1 project setup file, in place of `dotenv/config`: loads .env with the same precedence (a
// variable that is already set wins) but refuses S1_DIAG_*/MANAGED_DIAG_* in the file, so .env
// can never enable the S1-08 diagnostic override. The runner's per-batch variables are kept.
import { loadDotenvWithoutDiagnostics } from './db/diagnostic-override';

loadDotenvWithoutDiagnostics();
