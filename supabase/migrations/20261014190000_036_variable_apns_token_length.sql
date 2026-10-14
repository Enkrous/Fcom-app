-- APNs tokens have variable byte length; never freeze a 32-byte assumption.
-- https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns
ALTER TABLE public.device_tokens DROP CONSTRAINT device_tokens_token_check;
ALTER TABLE public.device_tokens ADD CONSTRAINT device_tokens_token_check CHECK (
  token ~ '^[0-9a-f]+$' AND length(token) BETWEEN 2 AND 1024 AND length(token) % 2 = 0
);
