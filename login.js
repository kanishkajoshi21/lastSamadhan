const parameters = new URLSearchParams(window.location.search);
const normalizeRole = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'department' ? 'department' : 'citizen';
};
const role = normalizeRole(parameters.get('role'));
const authForm = document.getElementById('authForm');
const authMessage = document.getElementById('authMessage');
const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const switchModeButton = document.getElementById('switchMode');
const nameField = document.getElementById('nameField');
const phoneField = document.getElementById('phoneField');
const passwordHelp = document.getElementById('passwordHelp');
const submitButton = document.getElementById('submitButton');
const authTitle = document.getElementById('authTitle');
const authIntro = document.getElementById('authIntro');
const roleBadge = document.getElementById('roleBadge');
const switchCopy = document.getElementById('switchCopy');
const authTabs = document.getElementById('authTabs');
const departmentHelp = document.getElementById('departmentHelp');
const signOutOtherAccount = document.getElementById('signOutOtherAccount');
const emailInput = authForm.elements.email;
const phoneInput = authForm.elements.phone;

let isRegistering = false;
const getApiBaseUrl = () => {
    const port = String(window.location.port || '').trim();
    const host = String(window.location.hostname || '').trim();
    if (port === '5000') {
        return '';
    }
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
        return 'http://localhost:5000';
    }
    return '';
};
const API_BASE_URL = getApiBaseUrl();
async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        return {
            success: false,
            message: `Backend returned ${response.status} ${response.statusText}. Expected JSON from the API.`
        };
    }
    try {
        return await response.json();
    } catch (error) {
        return { success: false, message: 'Backend returned an invalid JSON response.' };
    }
}

function setMode(registering) {
    isRegistering = registering && role === 'citizen';
    const translate = (key) => {
        const i18n = window.SamadhanI18n || { translate: (value) => value };
        return i18n.translate(key);
    };

    authTitle.textContent = role === 'department'
        ? translate('departmentSignIn')
        : translate(isRegistering ? 'createAccount' : 'citizenSignIn');
    roleBadge.textContent = translate(role);
    authIntro.textContent = translate(role === 'department' ? 'departmentAuthIntro' : 'citizenAuthIntro');
    submitButton.textContent = translate(isRegistering ? 'registerButton' : 'loginButton');
    nameField.classList.toggle('hidden', !isRegistering);
    phoneField.classList.toggle('hidden', !isRegistering);
    passwordHelp.classList.toggle('hidden', !isRegistering);
    nameField.querySelector('input').required = isRegistering;
    phoneInput.required = isRegistering;
    phoneInput.pattern = isRegistering ? '\\+[1-9][0-9]{7,14}' : '';
    emailInput.pattern = isRegistering ? '[A-Za-z0-9._%+-]+@gmail\\.com' : '';
    authForm.elements.password.autocomplete = isRegistering ? 'new-password' : 'current-password';
    authForm.elements.password.minLength = isRegistering ? 8 : 1;
    authTabs.classList.toggle('hidden', role === 'department');
    switchCopy.classList.toggle('hidden', role === 'department');
    departmentHelp.classList.toggle('hidden', role !== 'department');
    loginTab.classList.toggle('active', !isRegistering);
    registerTab.classList.toggle('active', isRegistering);
    submitButton.disabled = false;

    if (role === 'citizen') {
        switchCopy.querySelector('span').textContent = translate(isRegistering ? 'alreadyAccount' : 'noAccount');
        switchModeButton.textContent = translate(isRegistering ? 'signIn' : 'createAccount');
    }
    authMessage.textContent = '';
    authMessage.classList.remove('success');
}

function destinationFor(userRole) {
    const destination = userRole === 'department' ? '/dashboard.html' : '/citizen-dashboard.html';
    return `${API_BASE_URL}${destination}`;
}

async function redirectIfSignedIn() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' });
        if (!response.ok) return;
        const { user } = await parseJsonResponse(response);
        if (user.role === role) {
            window.location.replace(destinationFor(user.role));
        } else {
            authMessage.textContent = window.SamadhanI18n.translate('accountSwitchRequired');
            signOutOtherAccount.classList.remove('hidden');
        }
    } catch (error) {
        authMessage.textContent = window.SamadhanI18n.translate('authError');
    }
}

signOutOtherAccount.addEventListener('click', async () => {
    try {
        await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
        signOutOtherAccount.classList.add('hidden');
        authMessage.textContent = '';
    } catch (error) {
        authMessage.textContent = window.SamadhanI18n.translate('authError');
    }
});

loginTab.addEventListener('click', () => setMode(false));
registerTab.addEventListener('click', () => setMode(true));
switchModeButton.addEventListener('click', () => setMode(!isRegistering));

authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authMessage.textContent = '';
    submitButton.disabled = true;

    const formData = new FormData(authForm);
    const payload = {
        email: formData.get('email'),
        password: formData.get('password'),
    };
    const endpoint = isRegistering
        ? `${API_BASE_URL}/api/auth/register`
        : role === 'department'
            ? `${API_BASE_URL}/api/department/login`
            : `${API_BASE_URL}/api/auth/login`;
    if (isRegistering) {
        payload.name = formData.get('name');
        payload.phone = formData.get('phone');
    } else if (role !== 'department') {
        payload.role = role;
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await parseJsonResponse(response);
        if (!response.ok) {
            const errorKey = response.status === 401
                ? 'invalidCredentials'
                : response.status === 409
                    ? 'emailInUse'
                    : response.status === 400 && isRegistering
                        ? 'registrationValidation'
                        : '';
            throw new Error(errorKey
                ? window.SamadhanI18n.translate(errorKey)
                : result.message || window.SamadhanI18n.translate('authError'));
        }
        if (!result.user || !result.user.role) {
            throw new Error('Backend returned an invalid login response.');
        }
        window.location.replace(destinationFor(result.user.role));
    } catch (error) {
        const fallbackMessage = error && error.name === 'TypeError'
            ? window.SamadhanI18n.translate('serverUnavailable')
            : error && error.message ? error.message : window.SamadhanI18n.translate('authError');
        authMessage.textContent = fallbackMessage;
        if (error && error.name === 'TypeError') {
            console.error('Login fetch failed. Check backend URL and server status.', { endpoint, API_BASE_URL, error });
        }
    } finally {
        submitButton.disabled = false;
    }
});

document.addEventListener('samadhan:language-change', () => setMode(isRegistering));
document.addEventListener('DOMContentLoaded', () => {
    setMode(false);
    redirectIfSignedIn();
});
