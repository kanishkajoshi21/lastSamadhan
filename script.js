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

async function loadComplaintList() {
    const list = document.getElementById("complaintList");
    if (!list) return;

    try {
        const response = await fetch("http://localhost:5000/api/complaints");
        const data = await response.json();

        const complaints = data.complaints || [];

        if (!complaints.length) {
            list.innerHTML = "<p class='empty-state'>No complaint submitted yet.</p>";
            return;
        }

        list.innerHTML = complaints.slice(0, 5).map(item => `
            <div class="complaint-item">
                <div class="complaint-top">
                    <strong>${item.title}</strong>
                    <span class="${item.priority.toLowerCase()}">${item.priority}</span>
                </div>
                <p>${item.description}</p>
                <small>${item.department} • ${item.status}</small>
            </div>
        `).join("");
    } catch (error) {
        list.innerHTML = "<p class='empty-state'>Server is not responding yet.</p>";
    }
}

async function submitComplaint(event) {
    event.preventDefault();

    const form = event.target;
    const message = document.getElementById("formMessage");
    const submitButton = form.querySelector("button[type='submit']");

    const payload = {
        name: form.name.value,
        email: form.email.value,
        phone: form.phone.value,
        location: form.location.value,
        title: form.title.value,
        description: form.description.value,
    };

    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    message.textContent = "";

    try {
        const response = await fetch("http://localhost:5000/api/complaints", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.message || "Submission failed.");
        }

        message.textContent = "Complaint submitted successfully!";
        message.className = "form-message success";
        form.reset();
        loadComplaintList();
    } catch (error) {
        message.textContent = error.message;
        message.className = "form-message error";
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Complaint";
    }
}

function showMessage() {
    const formSection = document.getElementById("complaint-form");
    if (formSection) {
        formSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

document.addEventListener("DOMContentLoaded", function() {
    const complaintForm = document.getElementById("complaintForm");
    if (complaintForm) {
        complaintForm.addEventListener("submit", submitComplaint);
    }

    loadComplaintList();
});
