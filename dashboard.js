const complaintTableBody = document.getElementById('complaintTableBody');
const totalComplaints = document.getElementById('totalComplaints');
const pendingCount = document.getElementById('pendingCount');
const highPriorityCount = document.getElementById('highPriorityCount');
const inProgressCount = document.getElementById('inProgressCount');
const resolvedCount = document.getElementById('resolvedCount');
const refreshBtn = document.getElementById('refreshBtn');
const complaintDialog = document.getElementById('complaintDialog');
const departmentNotifications = document.getElementById('departmentNotifications');
const detailMessage = document.getElementById('detailMessage');
const pageHost = String(window.location.hostname || '').trim();
const API_BASE_URL = window.location.port === '5000'
  ? ''
  : (!pageHost || ['localhost', '127.0.0.1', '[::1]'].includes(pageHost) ? 'http://localhost:5000' : '');

let currentComplaints = [];
let selectedComplaint = null;

const translate = (key) => window.SamadhanI18n.translate(key);
const translateDepartment = (department) => window.SamadhanI18n.translateDepartment(department);
const translatePriority = (priority) => window.SamadhanI18n.translatePriority(priority);
const translateStatus = (status) => window.SamadhanI18n.translateStatus(status);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character]);
}

function formatStatus(status = 'Submitted') {
  return status.toLowerCase().replace(/\s+/g, '-') || 'submitted';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(window.SamadhanI18n.getLanguage(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function normalizeStatus(value) {
  if (value === 'Pending' || value === 'Under Review') return 'Under Verification';
  return value || 'Submitted';
}

function formatVerificationLabel(value = '') {
  return String(value || 'under_verification').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderStats(complaints) {
  totalComplaints.textContent = complaints.length;
  pendingCount.textContent = complaints.filter((item) => ['Submitted', 'Under Verification', 'More Evidence Required', 'Verified', 'Assigned', 'Under Review', 'Pending'].includes(normalizeStatus(item.status))).length;
  highPriorityCount.textContent = complaints.filter((item) => item.priority === 'High').length;
  inProgressCount.textContent = complaints.filter((item) => normalizeStatus(item.status) === 'In Progress').length;
  resolvedCount.textContent = complaints.filter((item) => ['Resolved', 'Closed'].includes(normalizeStatus(item.status))).length;
}

function renderNotifications(complaints) {
  const latest = complaints
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, 5);

  if (!latest.length) {
    departmentNotifications.innerHTML = `<p class="empty-state">${escapeHtml(translate('noDepartmentComplaints'))}</p>`;
    return;
  }
  departmentNotifications.innerHTML = latest.map((item) => `
    <article class="department-notification">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(translateStatus(item.status))}</span>
      <small>${escapeHtml(new Intl.DateTimeFormat(window.SamadhanI18n.getLanguage(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(item.updatedAt || item.createdAt)))}</small>
    </article>
  `).join('');
}

function renderTable(complaints) {
  if (!complaints.length) {
    complaintTableBody.innerHTML = `<tr><td colspan="10" class="empty-state">${escapeHtml(translate('noDepartmentComplaints'))}</td></tr>`;
    renderNotifications(complaints);
    return;
  }

  complaintTableBody.innerHTML = complaints
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((item) => {
      const priorityClass = ['High', 'Medium', 'Low'].includes(item.priority) ? item.priority.toLowerCase() : 'medium';
      const safeStatus = normalizeStatus(item.status);
      const statusClass = formatStatus(safeStatus);
      const routineStatuses = safeStatus === 'Assigned'
        ? ['Assigned', 'In Progress']
        : safeStatus === 'In Progress'
          ? ['In Progress', 'Resolved']
          : safeStatus === 'Resolved'
            ? ['Resolved']
            : [];

      return `
        <tr>
          <td>#${escapeHtml(item.id)}</td>
          <td>${escapeHtml(item.category || 'General Grievance')}</td>
          <td>
            <strong>${escapeHtml((item.title || 'Untitled complaint').slice(0, 60))}</strong>
            <div class="table-subtext">${escapeHtml(item.description || item.location || 'No description provided')}</div>
          </td>
          <td>${escapeHtml(translateDepartment(item.department || 'General'))}</td>
          <td><span class="priority ${priorityClass}">${escapeHtml(translatePriority(item.priority || 'Medium'))}</span></td>
          <td><span class="badge ${statusClass}">${escapeHtml(translateStatus(safeStatus))}</span></td>
          <td><span class="review-badge ${escapeHtml(formatStatus(item.verificationStatus || 'under_verification'))}">${escapeHtml(formatVerificationLabel(item.verificationStatus))}</span></td>
          <td><time datetime="${escapeHtml(item.createdAt || '')}">${escapeHtml(formatDateTime(item.createdAt))}</time></td>
          <td>
            <select class="status-select" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(translate('updateStatus'))}" ${routineStatuses.length ? '' : 'disabled'}>
              ${routineStatuses.map((status) => `
                <option value="${status}" ${safeStatus === status ? 'selected' : ''}>${escapeHtml(translateStatus(status))}</option>
              `).join('')}
            </select>
          </td>
          <td><button type="button" class="details-button" data-id="${escapeHtml(item.id)}">${escapeHtml(translate('viewDetails'))}</button></td>
        </tr>`;
    }).join('');

  complaintTableBody.querySelectorAll('.status-select').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/complaints/${encodeURIComponent(select.dataset.id)}/status`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: select.value, remarks: 'Department status update.' }),
        });
        if (response.status === 401) {
          window.location.replace(`${API_BASE_URL}/login.html?role=department`);
          return;
        }
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.message || 'Status update failed.');
        }
        await loadComplaints();
      } catch (error) {
        window.alert(error.message);
        await loadComplaints();
      }
    });
  });

  complaintTableBody.querySelectorAll('.details-button').forEach((button) => {
    button.addEventListener('click', () => {
      selectedComplaint = currentComplaints.find((item) => item.id === button.dataset.id);
      if (selectedComplaint) showComplaintDetails(selectedComplaint);
    });
  });
  renderNotifications(complaints);
}

async function showComplaintDetails(complaint) {
  const normalizedStatus = normalizeStatus(complaint.status);
  document.getElementById('detailTitle').textContent = complaint.title;
  document.getElementById('detailCitizen').textContent = complaint.name || complaint.email || '—';
  document.getElementById('detailLocation').textContent = complaint.location || '—';
  document.getElementById('detailPriority').textContent = translatePriority(complaint.priority || '—');
  document.getElementById('detailStatus').textContent = translateStatus(normalizedStatus);
  document.getElementById('detailDescription').textContent = complaint.description;
  const routineStatus = ['Assigned', 'In Progress', 'Resolved'].includes(normalizedStatus);
  const detailActions = document.getElementById('detailActions');
  detailActions.classList.toggle('hidden', !routineStatus);
  document.getElementById('detailStatusSelect').value = routineStatus ? normalizedStatus : 'Assigned';
  document.getElementById('detailDepartmentSelect').value = complaint.department;
  document.getElementById('detailRemarkInput').value = '';
  document.getElementById('verificationReview').classList.toggle('hidden', !['Under Verification', 'More Evidence Required'].includes(normalizedStatus));
  const analysis = complaint.verification || {};
  document.getElementById('detailVerificationStatus').textContent = formatVerificationLabel(complaint.verificationStatus);
  document.getElementById('detailVerificationSummary').textContent = complaint.verificationSummary || 'Awaiting human review.';
  document.getElementById('detailAiAssessment').textContent = analysis.assessment || 'unclear';
  document.getElementById('detailPhotoMatch').textContent = analysis.photoMatch || (complaint.photo ? 'unclear' : 'no photo attached');
  document.getElementById('detailDuplicate').textContent = analysis.possibleDuplicate ? 'Possible duplicate' : 'No duplicate indicated';
  document.getElementById('detailNearbyReports').textContent = Array.isArray(analysis.nearbyReports) && analysis.nearbyReports.length
    ? `${analysis.nearbyReports.length} within 250 m (supporting evidence)`
    : (complaint.latitude != null && complaint.longitude != null ? 'No nearby reports found' : 'No GPS comparison');
  document.getElementById('detailAiAvailability').textContent = analysis.analysisStatus === 'complete' ? 'Gemini response available' : 'AI unavailable; human review required';
  document.getElementById('verificationReason').value = '';
  document.getElementById('verificationMessage').textContent = '';
  document.getElementById('accountActionReason').value = '';
  document.getElementById('accountActionMessage').textContent = '';
  const photo = document.getElementById('detailPhoto');
  photo.classList.toggle('hidden', !complaint.photo);
  photo.src = complaint.photo || '';
  photo.alt = complaint.title;
  detailMessage.textContent = '';
  const evidenceList = document.getElementById('requestedEvidenceList');
  evidenceList.replaceChildren();
  try {
    const response = await fetch(`${API_BASE_URL}/api/complaints/${encodeURIComponent(complaint.id)}/evidence`, { credentials: 'include' });
    if (response.ok) {
      const { evidence = [] } = await response.json();
      for (const item of evidence) {
        const entry = document.createElement('article');
        entry.className = 'requested-evidence-item';
        const note = document.createElement('p');
        note.textContent = item.evidence_text || 'Photo evidence submitted.';
        entry.append(note);
        if (item.photo) {
          const image = document.createElement('img');
          image.src = item.photo;
          image.alt = 'Citizen submitted supporting evidence';
          image.className = 'detail-photo';
          entry.append(image);
        }
        const date = document.createElement('small');
        date.textContent = new Date(item.timestamp).toLocaleString();
        entry.append(date);
        evidenceList.append(entry);
      }
    }
  } catch {
    const unavailable = document.createElement('p');
    unavailable.textContent = 'Additional evidence could not be loaded.';
    evidenceList.append(unavailable);
  }
  complaintDialog.showModal();
}

async function saveComplaintChanges() {
  if (!selectedComplaint) return;
  const changes = [];
  const selectedStatus = document.getElementById('detailStatusSelect').value;
  const selectedDepartment = document.getElementById('detailDepartmentSelect').value;
  if (!document.getElementById('detailActions').classList.contains('hidden')
    && selectedStatus !== normalizeStatus(selectedComplaint.status)) {
    changes.push({
      endpoint: `${API_BASE_URL}/api/complaints/${encodeURIComponent(selectedComplaint.id)}/status`,
      body: {
        status: selectedStatus,
        remarks: document.getElementById('detailRemarkInput').value.trim(),
      },
    });
  }
  if (selectedDepartment !== selectedComplaint.department) {
    changes.push({
      endpoint: `${API_BASE_URL}/api/complaints/${encodeURIComponent(selectedComplaint.id)}/department`,
      body: { department: selectedDepartment },
    });
  }
  if (!changes.length) {
    complaintDialog.close();
    return;
  }

  detailMessage.textContent = '';
  const saveButton = document.getElementById('saveComplaintButton');
  saveButton.disabled = true;
  try {
    for (const change of changes) {
      const response = await fetch(change.endpoint, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change.body),
      });
      if (response.status === 401) {
        window.location.replace(`${API_BASE_URL}/login.html?role=department`);
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Unable to save complaint changes.');
    }
    complaintDialog.close();
    await loadComplaints();
  } catch (error) {
    detailMessage.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

async function saveVerificationDecision(button) {
  if (!selectedComplaint) return;
  const reason = document.getElementById('verificationReason').value.trim();
  const message = document.getElementById('verificationMessage');
  if (!reason) {
    message.textContent = 'Add a reason for this verification decision.';
    return;
  }
  const buttons = Array.from(document.querySelectorAll('[data-verification-action]'));
  buttons.forEach((item) => { item.disabled = true; });
  try {
    const response = await fetch(`${API_BASE_URL}/api/complaints/${encodeURIComponent(selectedComplaint.id)}/verification`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: button.dataset.verificationAction, reason }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to save verification decision.');
    complaintDialog.close();
    await loadComplaints();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}

async function saveAccountAction() {
  if (!selectedComplaint) return;
  const reason = document.getElementById('accountActionReason').value.trim();
  const message = document.getElementById('accountActionMessage');
  if (!reason) {
    message.textContent = 'Add a reason for this account action.';
    return;
  }
  const button = document.getElementById('saveAccountActionButton');
  button.disabled = true;
  try {
    const email = selectedComplaint.ownerEmail || selectedComplaint.email;
    const response = await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(email)}/restriction`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: document.getElementById('accountActionSelect').value, reason }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to save account action.');
    message.textContent = result.message;
    document.getElementById('accountActionReason').value = '';
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadComplaints() {
  try {
    const [profileResponse, complaintResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' }),
      fetch(`${API_BASE_URL}/api/complaints`, { credentials: 'include' }),
    ]);
    if (profileResponse.status === 401 || complaintResponse.status === 401) {
      window.location.replace(`${API_BASE_URL}/login.html?role=department`);
      return;
    }
    if (!profileResponse.ok || !complaintResponse.ok) {
      throw new Error('Unable to load department dashboard.');
    }
    const [{ user }, data] = await Promise.all([profileResponse.json(), complaintResponse.json()]);
    if (user.role !== 'department') {
      window.location.replace(`${API_BASE_URL}/`);
      return;
    }
    currentComplaints = data.complaints || [];
    document.getElementById('departmentProfile').textContent = `${user.name} · ${translateDepartment(user.department)}`;
    renderStats(currentComplaints);
    renderTable(currentComplaints);
  } catch (error) {
    complaintTableBody.innerHTML = `<tr><td colspan="10" class="empty-state">${escapeHtml(translate('loadError'))}</td></tr>`;
  }
}

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch (error) {
    window.alert(translate('serverUnavailable'));
  } finally {
    window.location.replace(`${API_BASE_URL}/`);
  }
});
document.getElementById('saveComplaintButton').addEventListener('click', saveComplaintChanges);
document.getElementById('saveAccountActionButton').addEventListener('click', saveAccountAction);
document.querySelectorAll('[data-verification-action]').forEach((button) => {
  button.addEventListener('click', () => saveVerificationDecision(button));
});
refreshBtn.addEventListener('click', loadComplaints);
document.addEventListener('samadhan:language-change', loadComplaints);
loadComplaints();
