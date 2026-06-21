import { APP_NAME } from '@shared/appConfig'

export const WEB_SEARCH_NAME = 'WebSearch'

export const WEB_SEARCH_DESCRIPTION = `Allows ${APP_NAME} to search the web and use the results to inform responses.

- Provides up-to-date information for current events and recent data.
- Returns search result information with titles, URLs, and snippets.
- Use this tool for accessing information beyond the model's knowledge cutoff.
- Searches are performed automatically within a single tool call.
- When web search informed your answer, end the response with a "Sources:" section listing the relevant URLs as markdown links: [Title](URL).
- After finding a relevant result, use web_fetch to retrieve the full page content when you need more than the snippet.

Usage notes:
- "query" should be concise and specific.
- "limit" optionally controls the maximum number of results to return.
- Use domain names or product/version terms in the query when they matter.

IMPORTANT - Use the correct year in search queries:
- The current year is 2026. You MUST use this year when searching for recent information, documentation, or current events.
- Example: If the user asks for "latest React docs", search for "React documentation 2026", NOT an older year.`
