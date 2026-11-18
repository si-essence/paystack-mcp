import { asSecretScope, currentSecretScope, redactLogLine, type SecretScope } from "./redact.js";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export function createLogger(
  secrets: SecretScope | readonly string[],
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): Logger {
  const fallback = asSecretScope(secrets);
  const emit = (level: "info" | "error", message: string): void => {
    const scope = currentSecretScope(fallback);
    write(`${level} ${redactLogLine(message, scope)}`);
  };
  return {
    info: (message) => {
      emit("info", message);
    },
    error: (message) => {
      emit("error", message);
    },
  };
}

/** Apply the active request scope to an injected logger (tests, runtime overrides). */
export function bindLogger(logger: Logger, fallback: SecretScope): Logger {
  return {
    info: (message) => {
      logger.info(redactLogLine(message, currentSecretScope(fallback)));
    },
    error: (message) => {
      logger.error(redactLogLine(message, currentSecretScope(fallback)));
    },
  };
}
