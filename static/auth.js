const supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const authTopbar = document.getElementById("auth-topbar");
const authTopbarEmail = document.getElementById("auth-topbar-email");
const authTopbarSignout = document.getElementById("auth-topbar-signout");
const signedOutView = document.getElementById("signed-out-view");
const appContent = document.getElementById("app-content");
const googleSigninBtn = document.getElementById("google-signin-btn");

let currentSession = null;

function applyAuthState(session) {
  currentSession = session;
  window.__currentSession = session;

  if (session) {
    const email = session.user.email || "signed in";
    if (authTopbarEmail) authTopbarEmail.textContent = email;
    if (authTopbar) authTopbar.style.display = "flex";
    if (signedOutView) signedOutView.style.display = "none";
    if (appContent) appContent.style.display = "grid";
    window.dispatchEvent(new CustomEvent("auth-ready", { detail: session }));
  } else {
    if (authTopbar) authTopbar.style.display = "none";
    if (signedOutView) signedOutView.style.display = "block";
    if (appContent) appContent.style.display = "none";
  }
}

/** Returns the current access token, or null if not signed in. Used by
 * script.js to attach Authorization headers to API calls. */
function getAccessToken() {
  return currentSession ? currentSession.access_token : (window.__currentSession ? window.__currentSession.access_token : null);
}

googleSigninBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
});

authTopbarSignout.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
});

supabaseClient.auth.onAuthStateChange((_event, session) => {
  applyAuthState(session);
});

supabaseClient.auth.getSession().then(({ data: { session } }) => {
  applyAuthState(session);
});