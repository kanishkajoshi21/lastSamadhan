import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const updateStatus = (id, newStatus) => {
  fetch(        //backend ko request bhejna for complaint status change
    `http://127.0.0.1:8000/complaints/${id}?status=${encodeURIComponent(newStatus)}`,
    {
      method: "PUT",
    }
  )
    .then((response) => response.json())
    .then((data) => {
      console.log(data);

      setComplaints((currentComplaints) =>   //ye part fronted per bhi complaint ka status update karta hai frpm pending to resolved aur vice versa
        currentComplaints.map((item) =>
          item.id === id
            ? { ...item, status: newStatus }
            : item
        )
      );
    })
    .catch((error) => {      //backend request fail ho gyi to error show hoga console pe
      console.log("Update Error:", error);
    });
};    //current value    new value
  const [backendMessage, setBackendMessage] = useState("");
  const [complaints, setComplaints] = useState([]);  //complaint ko store

  // Backend connection
  useEffect(() => {
    fetch("http://127.0.0.1:8000/")      //checks backend connection
      .then((response) => response.json())
      .then((data) => {
        setBackendMessage(data.message);
      })
      .catch((error) => {
        console.log("Backend Error:", error);
      });
  }, []);

  // Get complaints from backend
  useEffect(() => {
    fetch("http://127.0.0.1:8000/complaints")  //request backend to send info
      .then((response) => response.json())
      .then((data) => {
        setComplaints(data);
      })
      .catch((error) => {
        console.log("Complaint Error:", error);
      });
  }, []);

  return (
    <div className="dashboard">

      {/* Header */}
      <header className="header">
        <div>
          <h1>Department Dashboard</h1>
          <p>Complaint Management System</p>
          <p>{backendMessage}</p>
        </div>

        <div className="admin">
          Department Admin
        </div>
      </header>

      {/* Statistics */}
      <section className="stats">

        <div className="card">
          <h3>Total Complaints</h3>
          <h2>{complaints.length}</h2>
        </div>

        <div className="card">
          <h3>Pending</h3>
          <h2>
            {complaints.filter(
              (item) => item.status === "Pending"
            ).length}
          </h2>
        </div>

        <div className="card">
          <h3>In Progress</h3>
          <h2>
            {complaints.filter(
              (item) => item.status === "In Progress"
            ).length}
          </h2>
        </div>

        <div className="card">
          <h3>Resolved</h3>
          <h2>
            {complaints.filter(
              (item) => item.status === "Resolved"
            ).length}
          </h2>
        </div>

      </section>

      {/* Complaints */}
      <section className="complaint-section">

        <div className="section-heading">
          <h2>Recent Complaints</h2>

          <button className="refresh-btn">
            Refresh  /*onclick aan tha*/
          </button>
        </div>

        <div className="table-container">

          <table>

            <thead>
              <tr>
                <th>ID</th>
                <th>Complaint</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Update Status</th>
              </tr>
            </thead>

            <tbody>

              {complaints.map((item) => (

                <tr key={item.id}>

                  <td>#{item.id}</td>

                  <td>{item.complaint}</td>

                  <td>{item.category}</td>

                  <td>
                    <span     //priority show hogi 
                      className={`priority ${item.priority.toLowerCase()}`}
                    >
                      {item.priority}
                    </span>
                  </td>

                  <td>
                    <span
                      className={`status ${item.status
                        .toLowerCase()
                        .replace(" ", "-")}`}
                    >
                      {item.status}
                    </span>
                  </td>

                  <td>
                    <select
  value={item.status}
  onChange={(e) =>
    updateStatus(item.id, e.target.value)
  }
>
  <option>Pending</option>
  <option>In Progress</option>
  <option>Resolved</option>
</select>
                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      </section>

    </div>
  );
}

export default App;
