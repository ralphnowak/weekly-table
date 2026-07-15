import React from "react";
import { createRoot } from "react-dom/client";
import WeeklyTable from "./WeeklyTable.jsx";

document.body.style.margin = "0";
createRoot(document.getElementById("root")).render(<WeeklyTable />);
