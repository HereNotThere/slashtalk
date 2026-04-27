process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://slashtalk:slashtalk@localhost:5442/slashtalk_test";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6389";
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "test_client_id";
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "test_client_secret";
process.env.GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID || "test_app_client_id";
process.env.GITHUB_APP_CLIENT_SECRET =
  process.env.GITHUB_APP_CLIENT_SECRET || "test_app_client_secret";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "slashtalk-dev-repo-access";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_for_ci_that_is_long_enough";
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.BASE_URL = process.env.BASE_URL || "http://localhost:10000";
process.env.PORT = process.env.PORT || "10000";
