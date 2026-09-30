const citizenName = document.getElementById('citizenName');
const citizenList = document.getElementById('complaintList');
const notificationList = document.getElementById('notificationList');
const TRACKING_STEPS = ['Submitted', 'Under Verification', 'Verified', 'Assigned', 'In Progress', 'Resolved'];
const CITIZEN_PAGE_HOST = String(window.location.hostname || '').trim();
const CITIZEN_API_BASE_URL = window.location.port === '5000'
    ? ''
    : (!CITIZEN_PAGE_HOST || ['localhost', '127.0.0.1', '[::1]'].includes(CITIZEN_PAGE_HOST) ? 'http://localhost:5000' : '');
const citizenTranslate = (key) => window.SamadhanI18n.translate(key);
const translateDepartment = (department) => window.SamadhanI18n.translateDepartment(department);
const translatePriority = (priority) => window.SamadhanI18n.translatePriority(priority);
const translateStatus = (status) => window.SamadhanI18n.translateStatus(status);

function citizenEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    })[character]);
}

function formatCitizenDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(window.SamadhanI18n.getLanguage(), {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value));
}

function normalizeComplaintStatus(value) {
    if (value === 'Pending' || value === 'Under Review') return 'Under Verification';
    return value || 'Submitted';
}

function getComplaintTimelineMarkup(item, historyEntries = []) {
    const currentStatus = normalizeComplaintStatus(item.status);
    const stepMap = new Map((historyEntries || []).map((entry) => [normalizeComplaintStatus(entry.newStatus), entry]));
    const steps = TRACKING_STEPS.slice();
    if (stepMap.has('More Evidence Required') || currentStatus === 'More Evidence Required') {
        steps.splice(2, 0, 'More Evidence Required');
    }
    if (stepMap.has('Rejected') || currentStatus === 'Rejected') steps.push('Rejected');
    const currentIndex = steps.indexOf(currentStatus);

    return `
        <div class="complaint-status-timeline" aria-label="Complaint timeline for ${citizenEscape(item.id)}">
            ${steps.map((status) => {
                const statusIndex = steps.indexOf(status);
                const entry = stepMap.get(status) || (status === 'Submitted' ? { timestamp: item.createdAt || new Date().toISOString(), changedByRole: 'citizen', remarks: 'Complaint submitted.' } : null);
                const exceptionStatus = ['Rejected', 'More Evidence Required'].includes(currentStatus);
                const isDone = Boolean(entry) || (!exceptionStatus && currentIndex >= 0 && statusIndex < currentIndex);
                const isCurrent = status === currentStatus;
                const dateText = entry ? formatCitizenDate(entry.timestamp) : 'Pending';
                const roleText = entry
                    ? (entry.changedByRole === 'department' ? 'Department' : entry.changedByRole === 'system' ? 'System' : 'Citizen')
                    : '';
                const remarks = entry && entry.remarks ? `<div class="timeline-remark">${citizenEscape(entry.remarks)}</div>` : '';
                return `
                    <div class="timeline-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}">
                        <div class="timeline-node">${isCurrent ? '●' : (isDone ? '✓' : '○')}</div>
                        <div class="timeline-content">
                            <div class="timeline-status">${citizenEscape(translateStatus(status))}</div>
                            <div class="timeline-meta">${citizenEscape(dateText)}</div>
                            ${roleText ? `<div class="timeline-meta">${citizenEscape(roleText)}</div>` : ''}
                            ${remarks}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderCitizenComplaints(complaints, historyMap = {}) {
    document.getElementById('citizenTotal').textContent = complaints.length;
    document.getElementById('citizenPending').textContent = complaints
        .filter((item) => ['Submitted', 'Under Verification', 'More Evidence Required', 'Verified', 'Assigned', 'Under Review', 'Pending'].includes(normalizeComplaintStatus(item.status))).length;
    document.getElementById('citizenInProgress').textContent = complaints
        .filter((item) => normalizeComplaintStatus(item.status) === 'In Progress').length;
    document.getElementById('citizenResolved').textContent = complaints
        .filter((item) => ['Resolved', 'Closed'].includes(normalizeComplaintStatus(item.status))).length;

    if (!complaints.length) {
        citizenList.innerHTML = `<p class="empty-state" data-i18n="noMyComplaints">${citizenTranslate('noMyComplaints')}</p>`;
        notificationList.innerHTML = `<p class="empty-state">${citizenTranslate('noMyComplaints')}</p>`;
        return;
    }

    const sortedComplaints = complaints.slice().sort((a, b) => (
        new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    ));
    citizenList.innerHTML = sortedComplaints.map((item) => {
        const priority = String(item.priority || 'Low').toLowerCase();
        const timelineMarkup = getComplaintTimelineMarkup(item, historyMap[item.id] || []);
        const evidenceForm = item.status === 'More Evidence Required' ? `
            <section class="evidence-response" data-id="${citizenEscape(item.id)}">
                <strong>Additional evidence requested</strong>
                <label>
                    <span>Note or context</span>
                    <textarea data-evidence-text rows="3" maxlength="2000" placeholder="Add details that help the reviewer"></textarea>
                </label>
                <label class="evidence-upload">
                    <span>Supporting photo (optional)</span>
                    <input type="file" data-evidence-photo accept="image/jpeg,image/png,image/webp" capture="environment" />
                </label>
                <button type="button" class="evidence-submit">Send evidence</button>
                <p class="evidence-message" role="status" aria-live="polite"></p>
            </section>` : '';
        return `
            <article class="complaint-item">
                <div class="complaint-top">
                    <strong>${citizenEscape(item.title)}</strong>
                    <span class="${citizenEscape(priority)}">${citizenEscape(translatePriority(item.priority))}</span>
                </div>
                <p>${citizenEscape(item.description)}</p>
                ${item.photo ? `<img src="${citizenEscape(item.photo)}" alt="${citizenEscape(item.title)}" class="complaint-photo">` : ''}
                <small>${citizenEscape(item.id)} · ${citizenEscape(translateDepartment(item.department))} · ${citizenEscape(translateStatus(normalizeComplaintStatus(item.status)))}</small>
                ${timelineMarkup}
                ${evidenceForm}
            </article>`;
    }).join('');

    citizenList.querySelectorAll('[data-evidence-photo]').forEach((input) => {
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            const section = input.closest('.evidence-response');
            const message = section.querySelector('.evidence-message');
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
                input.value = '';
                message.textContent = 'Choose an image smaller than 5 MB.';
                return;
            }
            const reader = new FileReader();
            reader.onload = (event) => { input.dataset.preview = event.target.result; };
            reader.readAsDataURL(file);
        });
    });

    citizenList.querySelectorAll('.evidence-submit').forEach((button) => {
        button.addEventListener('click', async () => {
            const section = button.closest('.evidence-response');
            const message = section.querySelector('.evidence-message');
            const photoInput = section.querySelector('[data-evidence-photo]');
            button.disabled = true;
            message.textContent = 'Sending evidence…';
            try {
                const response = await fetch(`${CITIZEN_API_BASE_URL}/api/complaints/${encodeURIComponent(section.dataset.id)}/evidence`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        evidenceText: section.querySelector('[data-evidence-text]').value.trim(),
                        photo: photoInput.dataset.preview || '',
                    }),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Unable to send evidence.');
                await loadCitizenDashboard();
            } catch (error) {
                message.textContent = error.message;
            } finally {
                button.disabled = false;
            }
        });
    });

    notificationList.innerHTML = sortedComplaints.slice(0, 5).map((item) => {
        const updateLabel = item.updatedByRole ? citizenTranslate('updated') : citizenTranslate('submittedStatus');
        return `
            <article class="notification-item">
                <strong>${citizenEscape(item.title)}</strong>
                <p>${citizenEscape(translateStatus(normalizeComplaintStatus(item.status)))} · ${citizenEscape(translateDepartment(item.department))}</p>
                <small>${citizenEscape(updateLabel)} · ${citizenEscape(formatCitizenDate(item.updatedAt || item.createdAt))}</small>
            </article>`;
    }).join('');
}

async function loadCitizenDashboard() {
    try {
        const [profileResponse, complaintsResponse] = await Promise.all([
            fetch(`${CITIZEN_API_BASE_URL}/api/auth/me`, { credentials: 'include' }),
            fetch(`${CITIZEN_API_BASE_URL}/api/complaints`, { credentials: 'include' }),
        ]);

        if (profileResponse.status === 401 || complaintsResponse.status === 401) {
            window.location.replace(`${CITIZEN_API_BASE_URL}/login.html?role=citizen`);
            return;
        }
        if (profileResponse.status === 403 || complaintsResponse.status === 403) {
            window.location.replace('/');
            return;
        }
        if (!profileResponse.ok || !complaintsResponse.ok) {
            throw new Error('Unable to load citizen dashboard data.');
        }

        const [{ user }, { complaints }] = await Promise.all([
            profileResponse.json(),
            complaintsResponse.json(),
        ]);
        citizenName.textContent = user.name;
        document.getElementById('profileName').textContent = user.name;
        document.getElementById('profileEmail').textContent = user.email;
        document.getElementById('profilePhone').textContent = user.phone || '—';
        document.getElementById('citizenFormName').value = user.name;
        document.getElementById('citizenFormEmail').value = user.email;
        document.getElementById('citizenFormPhone').value = user.phone || '';

        const historyEntries = await Promise.all(complaints.map(async (complaint) => {
            const response = await fetch(`${CITIZEN_API_BASE_URL}/api/complaints/${encodeURIComponent(complaint.id)}/history`, { credentials: 'include' });
            if (!response.ok) return [complaint.id, []];
            const data = await response.json();
            return [complaint.id, data.history || []];
        }));

        const historyMap = Object.fromEntries(historyEntries);
        renderCitizenComplaints(complaints, historyMap);
    } catch (error) {
        citizenList.innerHTML = `<p class="empty-state">${citizenTranslate('loadError')}</p>`;
        notificationList.innerHTML = `<p class="empty-state">${citizenTranslate('loadError')}</p>`;
    }
}

document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
        await fetch(`${CITIZEN_API_BASE_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (error) {
        window.alert(citizenTranslate('serverUnavailable'));
    } finally {
        window.location.replace(`${CITIZEN_API_BASE_URL}/`);
    }
});

document.addEventListener('samadhan:complaints-updated', loadCitizenDashboard);
document.addEventListener('samadhan:language-change', loadCitizenDashboard);
loadCitizenDashboard();
