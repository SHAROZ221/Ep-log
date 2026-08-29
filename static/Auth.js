const supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const authBar = document.getElementById("auth-bar");
const signedOutView = document.getElementById("signed-out-view");
const appContent = document.getElementById("app-content");
const googleSigninBtn = document.getElementById("google-signin-btn");

let currentSession = null;

function renderAuthBar(session) {
  authBar.innerHTML = "";

  let emailTag = document.getElementById("auth-email-tag");
  let signoutBtn = document.getElementById("signout-btn");

  if (session) {
    const email = session.user.email || "signed in";

    if (!emailTag) {
      emailTag = document.createElement("div");
      emailTag.id = "auth-email-tag";
      emailTag.className = "auth-email-tag";
      document.body.appendChild(emailTag);
    }
    emailTag.textContent = email;
    emailTag.style.display = "block";

    if (!signoutBtn) {
      signoutBtn = document.createElement("button");
      signoutBtn.id = "signout-btn";
      signoutBtn.className = "auth-signout-btn-fixed";
      signoutBtn.textContent = "Eject";
      signoutBtn.title = "Sign out";
      document.body.appendChild(signoutBtn);
    }
    signoutBtn.style.display = "flex";
    signoutBtn.onclick = async () => {
      await supabaseClient.auth.signOut();
    };
  } else {
    if (emailTag) emailTag.style.display = "none";
    if (signoutBtn) signoutBtn.style.display = "none";
  }
}

function applyAuthState(session) {
  currentSession = session;
  renderAuthBar(session);

  if (session) {
    signedOutView.style.display = "none";
    appContent.style.display = "grid";
    window.dispatchEvent(new CustomEvent("auth-ready"));
  } else {
    signedOutView.style.display = "block";
    appContent.style.display = "none";
  }
}

/** Returns the current access token, or null if not signed in. Used by
 * script.js to attach Authorization headers to API calls. */
function getAccessToken() {
  return currentSession ? currentSession.access_token : null;
}

googleSigninBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
});

supabaseClient.auth.onAuthStateChange((_event, session) => {
  applyAuthState(session);
});

supabaseClient.auth.getSession().then(({ data: { session } }) => {
  applyAuthState(session);
});