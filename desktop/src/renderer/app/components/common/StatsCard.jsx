import React from "react";
import { motion } from "framer-motion";

const StatsCard = ({
  title,
  value,
  icon: Icon,
  color = "primary",
  trend,
  trendValue,
}) => {
  const colorClasses = {
    primary:
      "bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400",
    green:
      "bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400",
    red: "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400",
    yellow:
      "bg-yellow-50 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400",
    purple:
      "bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
    blue: "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="card dark:bg-gray-800 dark:border-gray-700"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
            {title}
          </p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {value}
          </p>
          {trend && (
            <p
              className={`text-xs mt-1 ${trend === "up" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
            >
              {trend === "up" ? "↑" : "↓"} {trendValue}
            </p>
          )}
        </div>
        <div className={`p-3 rounded-xl ${colorClasses[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </motion.div>
  );
};

export default StatsCard;
