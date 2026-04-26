export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  // Relying solely on HttpOnly cookies for authentication.
  // The 'credentials: include' option ensures the cookie is sent.
  
  return fetch(url, {
    ...options,
    credentials: 'include',
  });
}
