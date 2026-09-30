/* =========================
   MOBILE MENU
========================= */

function toggleMenu() {
    const menu = document.getElementById("navMenu");
    menu.classList.toggle("active");
}

document.querySelectorAll("#navMenu a").forEach(function(link) {
    link.addEventListener("click", function() {
        document.getElementById("navMenu").classList.remove("active");
    });
});

/* =========================
   FORM & API HANDLERS
========================= */

const pageHost = String(window.location.hostname || '').trim();
const API_BASE_URL = window.location.port === '5000'
    ? ''
    : (!pageHost || ['localhost', '127.0.0.1', '[::1]'].includes(pageHost) ? 'http://localhost:5000' : '');

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, function(character) {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;",
        };
        return entities[character];
    });
}

function readFormValue(form, fieldName) {
    const field = form.elements.namedItem(fieldName);
    return field && "value" in field ? field.value : "";
}

async function loadComplaintList() {
    const list = document.getElementById("complaintList");
    if (!list) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/complaints`, { credentials: 'include' });
        if (response.status === 401) {
            list.innerHTML = `<p class='empty-state'>${window.SamadhanI18n.translate("authRequired")}</p>`;
            return;
        }
        if (!response.ok) {
            throw new Error(window.SamadhanI18n.translate("serverUnavailable"));
        }
        const data = await response.json();

        const complaints = data.complaints || [];

        if (!complaints.length) {
            list.innerHTML = `<p class='empty-state'>${window.SamadhanI18n.translate("noComplaints")}</p>`;
            return;
        }

        list.innerHTML = complaints.slice(0, 5).map(item => `
            <div class="complaint-item">
                <div class="complaint-top">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span class="${escapeHtml(String(item.priority || "").toLowerCase())}">${escapeHtml(window.SamadhanI18n.translatePriority(item.priority))}</span>
                </div>
                <p>${escapeHtml(item.description)}</p>
                ${item.photo ? `<img src="${escapeHtml(item.photo)}" alt="${escapeHtml(item.title)}" class="complaint-photo" />` : ""}
                <small>${escapeHtml(window.SamadhanI18n.translateDepartment(item.department))} · ${escapeHtml(window.SamadhanI18n.translateStatus(item.status))}</small>
            </div>
        `).join("");
    } catch (error) {
        list.innerHTML = `<p class='empty-state'>${window.SamadhanI18n.translate("serverUnavailable")}</p>`;
    }
}

function bindVoiceInput() {
    const voiceButton = document.getElementById("voiceComplaintBtn");
    const descriptionField = document.getElementById("description");
    const message = document.getElementById("formMessage");

    if (!voiceButton || !descriptionField) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        voiceButton.disabled = true;
        voiceButton.title = window.SamadhanI18n.translate("voiceFailure");
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = ({
        en: "en-IN",
        hi: "hi-IN",
        pa: "pa-IN",
    })[window.SamadhanI18n.getLanguage()] || "en-IN";
    recognition.interimResults = false;

    let isListening = false;

    voiceButton.addEventListener("click", function() {
        if (isListening) return;

        recognition.start();
        isListening = true;
        voiceButton.disabled = true;
        voiceButton.textContent = window.SamadhanI18n.translate("voiceListening");
        if (message) {
            message.textContent = window.SamadhanI18n.translate("voiceListeningMessage");
            message.className = "form-message";
        }
    });

    recognition.addEventListener("result", function(event) {
        const transcript = event.results[0][0].transcript;
        const currentText = descriptionField.value.trim();
        descriptionField.value = currentText ? `${currentText} ${transcript}` : transcript;
    });

    recognition.addEventListener("end", function() {
        isListening = false;
        voiceButton.disabled = false;
        voiceButton.textContent = window.SamadhanI18n.translate("speakComplaint");
    });

    recognition.addEventListener("error", function() {
        isListening = false;
        if (message) {
            message.textContent = window.SamadhanI18n.translate("voiceFailure");
            message.className = "form-message error";
        }
        voiceButton.disabled = false;
        voiceButton.textContent = window.SamadhanI18n.translate("speakComplaint");
    });
}

function bindPhotoUpload() {
    const photoInput = document.getElementById("complaintPhoto");
    const photoPreview = document.getElementById("photoPreview");
    const message = document.getElementById("formMessage");

    if (!photoInput || !photoPreview) return;

    photoInput.addEventListener("change", function() {
        const file = this.files && this.files[0];

        if (!file) {
            photoPreview.classList.add("hidden");
            photoPreview.src = "";
            this.dataset.preview = "";
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            if (message) {
                message.textContent = window.SamadhanI18n.translate("photoTooLarge");
                message.className = "form-message error";
            }
            this.value = "";
            photoPreview.classList.add("hidden");
            photoPreview.src = "";
            this.dataset.preview = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = function(event) {
            photoPreview.src = event.target.result;
            photoPreview.classList.remove("hidden");
            photoInput.dataset.preview = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function bindLocationButtons() {
    document.querySelectorAll('[data-location-target]').forEach((button) => {
        const locationInput = document.getElementById(button.dataset.locationTarget);
        if (locationInput && !locationInput.dataset.locationListenerBound) {
            locationInput.addEventListener('input', () => {
                delete locationInput.dataset.latitude;
                delete locationInput.dataset.longitude;
            });
            locationInput.dataset.locationListenerBound = 'true';
        }
    });

    document.querySelectorAll('[data-location-target]').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.locationTarget);
            const status = button.parentElement.querySelector('.location-status');
            if (!input || !status) return;
            if (!navigator.geolocation) {
                status.textContent = 'Location is not available in this browser.';
                status.classList.add('error');
                return;
            }

            button.disabled = true;
            status.textContent = 'Finding your location…';
            status.classList.remove('error', 'success');
            navigator.geolocation.getCurrentPosition((position) => {
                const latitude = position.coords.latitude;
                const longitude = position.coords.longitude;
                input.dataset.latitude = String(latitude);
                input.dataset.longitude = String(longitude);
                input.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
                status.textContent = 'Location added. You can edit it before submitting.';
                status.classList.add('success');
                button.disabled = false;
            }, () => {
                status.textContent = 'Location unavailable. Enter it manually instead.';
                status.classList.add('error');
                button.disabled = false;
            }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
        });
    });
}

async function submitComplaint(event) {
    event.preventDefault();

    const form = event.target;
    const message = document.getElementById("formMessage");
    const submitButton = form.querySelector("button[type='submit']");
    const photoInput = document.getElementById("complaintPhoto");
    const photoPreview = document.getElementById("photoPreview");
    const locationInput = form.elements.namedItem("location");

    const payload = {
        name: readFormValue(form, "name"),
        email: readFormValue(form, "email"),
        phone: readFormValue(form, "phone"),
        location: readFormValue(form, "location"),
        title: readFormValue(form, "title"),
        description: readFormValue(form, "description"),
        photo: photoInput && photoInput.dataset.preview ? photoInput.dataset.preview : "",
        latitude: locationInput?.dataset.latitude || null,
        longitude: locationInput?.dataset.longitude || null,
    };

    submitButton.disabled = true;
    submitButton.textContent = window.SamadhanI18n.translate("submitting");
    message.textContent = "";

    try {
        const response = await fetch(`${API_BASE_URL}/api/complaints`, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            if (response.status === 401) {
                window.location.assign(`${API_BASE_URL}/login.html?role=citizen`);
                return;
            }
            throw new Error(result.message || "Submission failed.");
        }

        message.textContent = window.SamadhanI18n.translate("complaintSubmitted");
        message.className = "form-message success";
        form.reset();

        if (photoInput) {
            photoInput.dataset.preview = "";
            photoInput.value = "";
        }

        if (photoPreview) {
            photoPreview.src = "";
            photoPreview.classList.add("hidden");
        }

        if (document.getElementById("citizenName")) {
            document.dispatchEvent(new CustomEvent("samadhan:complaints-updated"));
        } else {
            loadComplaintList();
        }
    } catch (error) {
        message.textContent = error.message || window.SamadhanI18n.translate("serverUnavailable");
        message.className = "form-message error";
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = window.SamadhanI18n.translate("submitComplaint");
    }
}

function showMessage() {
    showPortalChooser();
}

function showPortalChooser() {
    const dialog = document.getElementById("portalDialog");
    if (dialog && typeof dialog.showModal === "function") {
        dialog.showModal();
    }
}

function closePortalChooser() {
    const dialog = document.getElementById("portalDialog");
    if (dialog) dialog.close();
}

document.addEventListener("DOMContentLoaded", function() {
    const complaintForm = document.getElementById("complaintForm");
    if (complaintForm) {
        complaintForm.addEventListener("submit", submitComplaint);
    }

    bindVoiceInput();
    bindPhotoUpload();
    bindLocationButtons();
    if (!document.getElementById("citizenName")) {
        loadComplaintList();
    }
});
