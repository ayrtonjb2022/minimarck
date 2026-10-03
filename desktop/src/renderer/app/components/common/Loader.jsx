import React from "react";

const Loader = ({ fullScreen = false, size = "md" }) => {
  const sizes = { sm: 24, md: 48, lg: 64 };

  const Spinner = () => (
    <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: sizes[size], color: "#7e9cd8" }}></i>
  );

  if (fullScreen) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,13,12,0.85)", zIndex: 9999 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 32 }}>
      <Spinner />
    </div>
  );
};

export default Loader;
