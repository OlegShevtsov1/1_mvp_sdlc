import { emit } from "./_lib/io.ts";
import { visualTurn } from "./_lib/visual.ts";

// Binding: delivery (the top-level deliver report). The first node of each visual round: reads
// the previous gate answer until_bash saved in ARTIFACTS_DIR.
emit(visualTurn(process.env.ARTIFACTS_DIR ?? ".", process.env.INPUTS_DELIVERY ?? ""));
