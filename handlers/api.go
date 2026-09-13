package handlers

import (
	"shopping-list/db"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
)

// GetAllData returns all sections with items and stats for offline caching
func GetAllData(c *fiber.Ctx) error {
	listID, err := requestedListID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid list_id parameter"})
	}
	var sections []db.Section
	var stats db.Stats
	if listID != 0 {
		sections, err = db.GetSectionsByList(listID)
		stats = db.GetListStats(listID)
	} else {
		sections, err = db.GetAllSections()
		stats = db.GetStats()
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Failed to fetch data"})
	}

	return c.JSON(fiber.Map{
		"sections":  sections,
		"stats":     stats,
		"timestamp": time.Now().Unix(),
	})
}

// requestedListID lets each open tab keep its own list even when another tab
// changes the application's shared active list. Zero means the legacy default.
func requestedListID(c *fiber.Ctx) (int64, error) {
	if !c.Context().QueryArgs().Has("list_id") {
		return 0, nil
	}
	listID, err := strconv.ParseInt(c.Query("list_id"), 10, 64)
	if err != nil || listID <= 0 {
		return 0, ErrInvalidListID
	}
	return listID, nil
}
