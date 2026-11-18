export const CONNECTOR_NAME = "paystack-mcp";
export const CONNECTOR_TITLE = "Paystack";
export const CONNECTOR_VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.paystack.co";
export const CURRENCIES = ["NGN", "GHS", "ZAR", "KES", "USD", "XOF", "EGP"] as const;
export type Currency = (typeof CURRENCIES)[number];
