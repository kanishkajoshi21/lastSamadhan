from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient

app = FastAPI()

# React frontend ko backend access karne dena
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# MongoDB connection
client = MongoClient("mongodb://localhost:27017")

db = client["department_dashboard"]
complaints_collection = db["complaints"]


# Home API
@app.get("/")
def home():
    return {
        "message": "Department Dashboard Backend is Running"
    }


# Get all complaints
@app.get("/complaints")
def get_complaints():

    complaints = list(complaints_collection.find({}, {"_id": 0}))

    return complaints


# Update complaint status
@app.put("/complaints/{complaint_id}")
def update_complaint_status(complaint_id: int, status: str):

    result = complaints_collection.update_one(
        {"id": complaint_id},
        {"$set": {"status": status}}
    )

    if result.matched_count == 0:
        return {
            "message": "Complaint not found"
        }

    updated_complaint = complaints_collection.find_one(
        {"id": complaint_id},
        {"_id": 0}
    )

    return {
        "message": "Complaint status updated",
        "complaint": updated_complaint
    }