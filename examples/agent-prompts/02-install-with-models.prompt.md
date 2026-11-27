---
mode: agent
description: Install with my models already configured
---

Deploy the orchestrator to workspace `<workspace name>`, lakehouse `<lakehouse name>`. I want to test two semantic models of that workspace:
`Sales` with the navigation file `PowerBIPerformanceData_Sales.json` and `Inventory` with `PowerBIPerformanceData_Inventory.json`.
`Sales` should ramp 5 and then 20 users; `Inventory` just 10 users with no think times. Use one users file per model with
`users_sales.txt` and `users_inventory.txt`. Write the `models` file for me, show it, then deploy.
