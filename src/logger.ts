export interface Logger {
  log: (...args: Array<any>) => void;
  info: (...args: Array<any>) => void;
  warn: (...args: Array<any>) => void;
  error: (...args: Array<any>) => void;
  debug: (...args: Array<any>) => void;
  trace: (...args: Array<any>) => void;
}

export const consoleLogger: Logger = {
  log: (...args: Array<any>) => console.log(...args),
  info: (...args: Array<any>) => console.info(...args),
  warn: (...args: Array<any>) => console.warn(...args),
  error: (...args: Array<any>) => console.error(...args),
  debug: (...args: Array<any>) => console.debug(...args),
  trace: (...args: Array<any>) => console.trace(...args),
};

export const noopLogger: Logger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};
