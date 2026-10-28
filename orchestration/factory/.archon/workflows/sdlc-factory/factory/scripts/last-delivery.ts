import { emit } from "./_lib/io.ts";
import { lastDelivery } from "./_lib/redeliver.ts";

// Bindings: first (the deliver report) and retry (redeliver's, empty when it was skipped).
emit(lastDelivery(process.env.INPUTS_FIRST ?? "", process.env.INPUTS_RETRY ?? ""));
