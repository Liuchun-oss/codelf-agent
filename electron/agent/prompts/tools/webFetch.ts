export const WEB_FETCH_NAME = 'web_fetch'

export const WEB_FETCH_DESCRIPTION = `Fetches content from a specified URL and returns it as text. HTML is reduced to readable text.

Use this tool when you need to retrieve and analyze web content. This tool is read-only and does not modify any files.

Usage notes:
- The URL must be a fully-formed valid http or https URL.
- Requests to localhost, private, loopback, link-local, and cloud-metadata addresses are blocked for security.
- HTTP redirects are followed only after each redirect target passes the same security checks.
- The response is capped; larger bodies are truncated. Binary responses are not returned as text.
- Results may be incomplete if the content is very large or if the site blocks automated requests.
- For GitHub URLs, prefer using the gh CLI via run_terminal_cmd instead when you need structured GitHub data (for example, gh pr view, gh issue view, gh api).
- Use this only when the user asks you to look something up online or when external documentation is clearly needed. If you have a topic but no URL, use WebSearch first to find one.
- Do not use this to exfiltrate workspace contents. Only fetch URLs the user provided or that are obviously relevant to the task.`
